import assert from "node:assert/strict";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setImmediate as immediate } from "node:timers/promises";
import { Python, PythonError, byReference } from "@node-ctypes/python";

const seconds = Number(process.argv[2]);
assert.ok(Number.isSafeInteger(seconds) && seconds > 0);
assert.ok(global.gc, "stress testing requires --expose-gc");

function handles() {
  const report: unknown = process.report.getReport();
  assert.ok(report !== null && typeof report === "object" && "libuv" in report && Array.isArray(report.libuv));
  const activeNonTimer: Record<string, number> = {};
  const referenced: Record<string, number> = {};
  const entries: unknown[] = report.libuv;
  const timers: unknown[] = [];
  for (const handle of entries) {
    assert.ok(handle !== null && typeof handle === "object" && "type" in handle && typeof handle.type === "string");
    if (handle.type === "timer") timers.push(handle);
    if ("is_active" in handle && handle.is_active === true) {
      if (handle.type !== "timer") activeNonTimer[handle.type] = (activeNonTimer[handle.type] ?? 0) + 1;
      if ("is_referenced" in handle && handle.is_referenced === true) referenced[handle.type] = (referenced[handle.type] ?? 0) + 1;
    }
  }
  return { activeNonTimer, referenced, timers };
}

await immediate();
const beforeHandles = handles();
const python = await Python.initialize({ stdin: false });
let created = 0;
let released = 0;
let operations = 0;
let rounds = 0;
const latencies = new Float64Array(4096);
const eventLoop = monitorEventLoopDelay({ resolution: 10 });
try {
  python.main.stress_sync = (value: number) => {
    if (value < 0) throw new RangeError(`callback:${value}`);
    return value + 1;
  };
  python.main.stress_async = async (value: number) => {
    await immediate();
    return value + 2;
  };
  python.main.stress_release = () => released++;
  await python.exec(`
import gc, tracemalloc
tracemalloc.start()
def stress_scalar(value):
    return value * 2
def stress_failure(value):
    raise ValueError(f"stress:{value}")
def stress_callback(value):
    return stress_sync(value)
async def stress_await(value):
    return await stress_async(value)
class StressHolder:
    def __init__(self, value, owner):
        self.value = value
        self.owner = owner
    def __del__(self):
        stress_release()
def stress_payload(value):
    return [value, {"text": "\\u03bb", "bytes": b"\\x00\\xff", "big": 2**80}]
`);
  const calls = {
    scalar: python.main.stress_scalar,
    failure: python.main.stress_failure,
    callback: python.main.stress_callback,
    awaitable: python.main.stress_await,
    holder: python.main.StressHolder,
    payload: python.main.stress_payload,
  };
  async function expectedFailure(task: Promise<unknown>, type: string, message: string, javascript = false) {
    await assert.rejects(task, (error: unknown) => {
      assert.ok(error instanceof PythonError);
      try {
        assert.equal(error.type, type);
        assert.ok(error.message.includes(message), error.message);
        if (javascript) {
          assert.ok(error.cause instanceof RangeError);
          assert.equal(error.cause.message, message);
        }
        return true;
      } finally {
        error.exception[Symbol.dispose]();
      }
    });
  }
  async function batch() {
    const base = rounds++ * 128;
    await Promise.all(
      Array.from({ length: 128 }, async (_, index) => {
        const value = base + index;
        const start = performance.now();
        switch (index % 7) {
          case 0:
            assert.equal(await calls.scalar(value), value * 2);
            break;
          case 1:
            await expectedFailure(calls.failure(value), "ValueError", `stress:${value}`);
            break;
          case 2:
            assert.equal(await calls.callback(value), value + 1);
            break;
          case 3:
            assert.equal(await calls.awaitable(value), value + 2);
            break;
          case 4: {
            const owner = { value, payload: new Uint8Array(4096) };
            const held = await calls.holder(value, byReference(owner));
            created++;
            assert.equal(held.value, value);
            assert.equal(held.owner, owner);
            if (index % 2 === 0) held[Symbol.dispose]();
            break;
          }
          case 5: {
            const payload = await calls.payload(value);
            try {
              assert.deepEqual(payload.toJS(), [value, { text: "\u03bb", bytes: Buffer.from([0, 255]), big: 2n ** 80n }]);
            } finally {
              payload[Symbol.dispose]();
            }
            break;
          }
          case 6:
            await expectedFailure(calls.callback(-value - 1), "RuntimeError", `callback:${-value - 1}`, true);
        }
        latencies[operations++ % latencies.length] = performance.now() - start;
      }),
    );
  }
  async function collect() {
    for (let pass = 0; pass < 3; pass++) {
      global.gc!();
      await immediate();
      await python.exec("gc.collect()");
      await immediate();
    }
    assert.equal(released, created, "every dropped or disposed holder must release its Python reference");
    return python.stats();
  }
  async function memorySample(elapsedSeconds: number) {
    const [pythonBytes, pythonTraceBytes, pythonBlocks] = await python.eval<[number, number, number]>("[tracemalloc.get_traced_memory()[0], tracemalloc.get_tracemalloc_memory(), __import__('sys').getallocatedblocks()]");
    return { ...process.memoryUsage(), round: rounds, elapsedSeconds, pythonBytes, pythonTraceBytes, pythonBlocks };
  }
  for (let warmup = 0; warmup < 4; warmup++) {
    await batch();
    await collect();
  }
  const baseline = await collect();
  const warmupOperations = operations;
  const memoryStart = await memorySample(0);
  const samples: Awaited<ReturnType<typeof memorySample>>[] = [];
  let lastSample = -Infinity;
  const started = performance.now();
  eventLoop.enable();
  do {
    await batch();
    assert.deepEqual(await collect(), baseline, "shared references and pending work must return to the warmed baseline");
    const elapsed = performance.now() - started;
    if (elapsed - lastSample >= 2000) {
      samples.push(await memorySample(elapsed / 1000));
      if (samples.length > 64) samples.shift();
      lastSample = elapsed;
    }
  } while (performance.now() - started < seconds * 1000);
  eventLoop.disable();

  const accepted = Array.from({ length: 256 }, (_, value) => (value % 2 ? calls.callback(value) : calls.scalar(value)));
  for (const callable of Object.values(calls)) callable[Symbol.dispose]();
  const closing = python.finalize();
  const refused = assert.rejects(() => python.eval("1"), /closing|finaliz/i);
  assert.deepEqual(
    await Promise.all(accepted),
    Array.from({ length: 256 }, (_, value) => (value % 2 ? value + 1 : value * 2)),
  );
  await closing;
  await refused;
  await python.finalize();
  for (let pass = 0; pass < 3; pass++) await immediate();
  const afterHandles = handles();
  assert.deepEqual(afterHandles.referenced, beforeHandles.referenced, "finalization must not leave new referenced native handles");
  // Node/V8 may schedule unreferenced GC timers independently of Python.
  assert.deepEqual(afterHandles.activeNonTimer, beforeHandles.activeNonTimer, "finalization must release its active callback handles");
  const ordered = Array.from(latencies.subarray(0, Math.min(operations, latencies.length))).sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      interpreter: { version: python.version, executable: python.executable },
      seconds: (performance.now() - started) / 1000,
      operations,
      warmupOperations,
      rounds,
      created,
      released,
      baseline,
      acceptedAtShutdown: accepted.length,
      handles: { before: beforeHandles, after: afterHandles },
      latencyMs: { p50: ordered[Math.floor(ordered.length * 0.5)], p95: ordered[Math.floor(ordered.length * 0.95)], p99: ordered[Math.floor(ordered.length * 0.99)] },
      eventLoopMaxMs: eventLoop.max / 1e6,
      memoryStart,
      samples,
    }),
  );
} finally {
  eventLoop.disable();
  await python.finalize();
}
