import assert from "node:assert/strict";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import { Python, PythonError, byReference } from "@node-ctypes/python";

assert.ok(global.gc, "backlog testing requires --expose-gc");
const python = await Python.initialize({ stdin: false });
const eventLoop = monitorEventLoopDelay({ resolution: 10 });
const payloadBytes = 1024;
let gated = false;
let epoch = 0;
interface BacklogState {
  base: number;
  callbacks: Uint32Array;
  audits: number;
  bodyMs?: ReturnType<typeof distribution>;
}
let active: BacklogState | undefined;

function distribution(values: ArrayLike<number>) {
  const sorted = Array.from(values).sort((a, b) => a - b);
  assert.ok(sorted.length > 0);
  return { p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.floor(sorted.length * 0.95)], p99: sorted[Math.floor(sorted.length * 0.99)], max: sorted.at(-1)! };
}

try {
  python.main.backlog_callback = (value: number) => {
    assert.ok(active);
    const index = value - active.base;
    assert.ok(index >= 0 && index < active.callbacks.length);
    active.callbacks[index]++;
    if (value % 4 === 3) throw new RangeError(`javascript:${value}:end`);
    return value + 1;
  };
  await python.exec(`
import gc, sys, time, tracemalloc
tracemalloc.start()
backlog_release = False
backlog_entered = False
backlog_seen = []
backlog_durations = []
backlog_tail = -1
def backlog_head():
    global backlog_entered
    backlog_entered = True
    deadline = time.monotonic() + 60
    while not backlog_release:
        if time.monotonic() >= deadline:
            raise TimeoutError('backlog test did not release its head request')
        time.sleep(0.001)
    return 'head'
def backlog_item(value, owner):
    started = time.perf_counter_ns()
    backlog_seen.append(value)
    try:
        assert owner.value == value
        if value % 4 == 1:
            raise ValueError(f'python:{value}:end')
        if value % 4 >= 2:
            return backlog_callback(value)
        return value * 2
    finally:
        backlog_durations.append(time.perf_counter_ns() - started)
        if value == backlog_tail:
            backlog_audit()
class BacklogObserver:
    @property
    def memory(self):
        current, peak = tracemalloc.get_traced_memory()
        return [len(backlog_seen), current, peak, tracemalloc.get_tracemalloc_memory(), sys.getallocatedblocks()]
    @property
    def audit(self):
        return [backlog_seen, backlog_durations]
backlog_observer = BacklogObserver()
`);
  const head = python.main.backlog_head;
  const work = python.main.backlog_item;
  const observer = python.main.backlog_observer;
  python.main.backlog_audit = () => {
    const current = active;
    assert.ok(current);
    const audit = observer.audit;
    try {
      const [seen, durations]: [number[], number[]] = audit.toJS();
      assert.deepEqual(
        seen,
        Array.from({ length: current.callbacks.length }, (_, index) => current.base + index),
        "Python must execute each accepted request exactly once and in queue order",
      );
      assert.equal(durations.length, current.callbacks.length);
      current.bodyMs = distribution(durations.map((value) => value / 1e6));
      current.audits++;
    } finally {
      audit[Symbol.dispose]();
    }
  };

  async function collect() {
    for (let pass = 0; pass < 3; pass++) {
      global.gc!();
      await immediate();
      await python.exec("gc.collect()");
      await immediate();
    }
    return python.stats();
  }

  function sample(phase: string, admitted: number, settled: number) {
    const memory = observer.memory;
    let values: number[];
    try {
      values = memory.toJS();
    } finally {
      memory[Symbol.dispose]();
    }
    assert.equal(values.length, 5);
    return {
      phase,
      admitted,
      settled,
      pendingPublic: admitted - settled,
      entered: values[0],
      ...process.memoryUsage(),
      pythonBytes: values[1],
      pythonPeakBytes: values[2],
      pythonTraceBytes: values[3],
      pythonBlocks: values[4],
      references: python.stats(),
    };
  }

  async function round(count: number, shutdown: boolean) {
    assert.ok(count > 0 && count % 4 === 0);
    python.main.backlog_release = false;
    python.main.backlog_entered = false;
    python.main.backlog_seen = [];
    python.main.backlog_durations = [];
    const base = epoch++ * 10000;
    const current: BacklogState = { base, callbacks: new Uint32Array(count), audits: 0 };
    active = current;
    python.main.backlog_tail = base + count - 1;
    const callbackCounts = active.callbacks;
    const terminal = new Uint8Array(count);
    const latencies = new Float64Array(count);
    const barriers: Promise<PromiseSettledResult<void>[]>[] = [];
    let admitted = 0;
    let settled = 0;
    let headSettled = 0;
    const before = sample("before", 0, 0);
    gated = true;
    const leader = head()
      .then((value: unknown) => assert.equal(value, "head"))
      .finally(() => headSettled++);
    const leaderBarrier = Promise.allSettled([leader]);
    const waiting = performance.now();
    while (!python.main.backlog_entered) {
      assert.ok(performance.now() - waiting < 10000, "the slow head must enter the Python executor");
      await immediate();
    }
    const heldAt = performance.now();
    const samples = [before];
    let maxEnqueueSliceMs = 0;
    const enqueueStarted = performance.now();
    for (let start = 0; start < count; start += 128) {
      const sliceStarted = performance.now();
      const slice: Promise<void>[] = [];
      for (let index = start; index < Math.min(start + 128, count); index++) {
        const value = base + index;
        const owner = { value, payload: new Uint8Array(payloadBytes).fill(index & 255) };
        const submitted = performance.now();
        const task = work(value, byReference(owner))
          .then(
            (result: unknown) => {
              assert.ok(index % 4 === 0 || index % 4 === 2, `request ${value} must reject`);
              assert.equal(result, index % 4 === 0 ? value * 2 : value + 1);
            },
            (error: unknown) => {
              assert.ok(error instanceof PythonError);
              try {
                assert.ok(index % 4 === 1 || index % 4 === 3, `request ${value} must succeed`);
                assert.equal(error.type, index % 4 === 1 ? "ValueError" : "RuntimeError");
                assert.ok(error.message.includes(`${index % 4 === 1 ? "python" : "javascript"}:${value}:end`), error.message);
                if (index % 4 === 3) {
                  assert.ok(error.cause instanceof RangeError);
                  assert.equal(error.cause.message, `javascript:${value}:end`);
                }
              } finally {
                error.exception[Symbol.dispose]();
              }
            },
          )
          .finally(() => {
            terminal[index]++;
            settled++;
            latencies[index] = performance.now() - submitted;
          });
        slice.push(task);
        admitted++;
      }
      barriers.push(Promise.allSettled(slice));
      maxEnqueueSliceMs = Math.max(maxEnqueueSliceMs, performance.now() - sliceStarted);
      if (admitted % Math.max(128, count / 4) === 0) samples.push(sample("filling", admitted + 1, settled + headSettled));
      await immediate();
    }
    const enqueueMs = performance.now() - enqueueStarted;
    global.gc!();
    await delay(100);
    const blocked = sample("blocked-after-gc", admitted + 1, settled + headSettled);
    samples.push(blocked);
    assert.equal(headSettled, 0);
    assert.equal(settled, 0, "the slow head must keep the entire generated workload pending");
    assert.equal(blocked.entered, 0, "no queued function may execute before the head is released");
    assert.equal(blocked.pendingPublic, count + 1);
    assert.equal(blocked.references.objects, before.references.objects + count, "queued arguments must retain all shared JavaScript owners even after forced GC");
    const headHoldMs = performance.now() - heldAt;
    const closing = shutdown ? python.finalize() : undefined;
    const refused = shutdown ? assert.rejects(() => python.eval("1"), /closing|finaliz/i) : undefined;
    const releasedAt = performance.now();
    python.main.backlog_release = true;
    gated = false;
    const outcomes = [...(await leaderBarrier), ...(await Promise.all(barriers)).flat()];
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((outcome) => outcome.reason),
        "backlog results failed validation",
      );
    assert.equal(headSettled, 1);
    assert.equal(settled, count);
    assert.equal(current.audits, 1, "Python execution must be audited before the tail request finishes, including during shutdown");
    assert.ok(current.bodyMs);
    assert.deepEqual(terminal, new Uint8Array(count).fill(1), "each public result or error must settle once");
    for (let index = 0; index < count; index++) assert.equal(callbackCounts[index], index % 4 >= 2 ? 1 : 0, `callback count for ${base + index}`);
    const drainMs = performance.now() - releasedAt;
    let after;
    let referencesAfterDrain: ReturnType<typeof python.stats>;
    if (shutdown) {
      await closing;
      await refused;
      const references = python.stats();
      assert.equal(references.objects, 0);
      assert.equal(references.functions, 0);
      assert.equal(references.awaits, 0);
      assert.equal(references.calls, 0);
      referencesAfterDrain = references;
      after = { phase: "finalized", ...process.memoryUsage(), references };
    } else {
      python.main.backlog_seen = [];
      python.main.backlog_durations = [];
      referencesAfterDrain = await collect();
      after = sample("drained-after-gc", admitted + 1, settled + headSettled);
    }
    active = undefined;
    return {
      count,
      shutdown,
      successes: count / 2,
      errors: count / 2,
      payloadBytes: count * payloadBytes,
      maxPendingPublic: count + 1,
      headHoldMs,
      enqueueMs,
      maxEnqueueSliceMs,
      drainMs,
      latencyMs: distribution(latencies),
      pythonBodyMs: current.bodyMs,
      samples,
      referencesAfterDrain,
      after,
    };
  }

  for (let warmup = 0; warmup < 2; warmup++) await round(32, false);
  const baseline = await collect();
  const rounds: Awaited<ReturnType<typeof round>>[] = [];
  eventLoop.enable();
  for (const count of [256, 1024, 4096]) {
    const result = await round(count, false);
    assert.deepEqual(result.referencesAfterDrain, baseline, "all shared references must return to the warmed baseline after draining");
    rounds.push(result);
  }
  rounds.push(await round(2048, true));
  eventLoop.disable();
  console.log(JSON.stringify({ interpreter: { version: python.version, executable: python.executable }, warmupRequests: 64, requests: rounds.reduce((sum, result) => sum + result.count, 0), baseline, eventLoopMaxMs: eventLoop.max / 1e6, rounds }));
} finally {
  eventLoop.disable();
  if (gated) python.main.backlog_release = true;
  await python.finalize();
}
