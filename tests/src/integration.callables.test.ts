import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { Python, PythonError, kwargs } from "@node-ctypes/python";

const python = await Python.initialize({ stdin: false });
after(async () => await python.finalize());
await python.exec("import asyncio, concurrent.futures, functools, gc, inspect, weakref");

function isPythonError(type: string, cause?: unknown) {
  return (error: unknown): boolean => {
    if (!(error instanceof PythonError)) return false;
    try {
      assert.equal(error.type, type);
      if (cause !== undefined) assert.equal(error.cause, cause);
      return true;
    } finally {
      error.exception[Symbol.dispose]();
    }
  };
}

it("runs the callbacks example with Python EventEmitter listeners to completion", () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("../../examples/callbacks.ts", import.meta.url))], {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "1" },
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  assert.equal(child.stderr, "");
  const output = stripVTControlCharacters(child.stdout);
  assert.match(output, /Node\.js EventEmitter created and used by Python: \[ 'from Python' \]/);
  assert.match(output, /Python received ticks 1, 2, 3/);
  assert.match(output, /Done!/);
});

it("preserves no-keyword calls, explicit empty keywords and positional-only errors", async () => {
  await python.exec(`
def positional_only(value, /):
    return value
def optional_keywords(value=40, *, offset=2):
    return value + offset
`);
  assert.equal(await python.main.positional_only(42), 42);
  assert.equal(await python.main.positional_only(42, kwargs({})), 42);
  assert.equal(await python.main.optional_keywords(), 42);
  assert.equal(await python.main.optional_keywords(41, kwargs({ offset: 1 })), 42);
  assert.equal(await python.builtins.abs(-42), 42);
  await assert.rejects(() => python.main.positional_only(kwargs({ value: 42 })), isPythonError("TypeError"));
  await assert.rejects(() => python.main.positional_only(), isPythonError("TypeError"));
  assert.equal(await python.main.positional_only(42), 42);
});

it("preserves Python function metadata and JavaScript round-trip identity", async () => {
  function answer(value: number) {
    return value + 1;
  }
  python.main.callable_answer = answer;
  python.main.callable_alias = answer;
  assert.equal(await python.eval("callable_answer"), answer);
  assert.equal(await python.eval("callable_alias"), answer);
  assert.deepEqual(await python.eval("[inspect.isfunction(callable_answer), callable_answer.__name__, callable_answer.__qualname__, callable_answer.__module__, callable_answer.__doc__, isinstance(callable_answer._node_ctypes_id, int)]"), [
    true,
    "answer",
    "answer",
    "_node_ctypes",
    "JavaScript function answer",
    true,
  ]);
  assert.equal(await python.eval("callable_answer is callable_alias"), false);
  assert.equal(await python.eval("callable_answer(41)"), 42);
});

it("does not mistake functools.wraps metadata for JavaScript wrapper code", async () => {
  await python.exec(`
@functools.wraps(callable_answer)
def decorated_answer(value):
    return callable_answer(value) + 1
`);
  const decorated = python.main.decorated_answer;
  assert.notEqual(decorated, await python.eval("callable_answer"));
  assert.equal(await decorated(40), 42);
  decorated[Symbol.dispose]();
});

it("preserves positional arguments, keyword conversion, reentry and exception causes", async () => {
  const failure = new RangeError("callable failed");
  python.main.callable_kwargs = (value: number, options: { offset: number }) => value + options.offset;
  python.main.callable_reentry = (value: number) => python.main.callable_offset + value;
  python.main.callable_offset = 1;
  python.main.callable_failure = () => {
    throw failure;
  };
  assert.equal(await python.eval("callable_kwargs(40, offset=2)"), 42);
  assert.equal(await python.eval("callable_reentry(41)"), 42);
  python.main.callable_async_reentry = async (value: number) => await python.eval<number>(`${value} + 1`);
  await assert.rejects(async () => await python.exec("callable_async_reentry(41)"), isPythonError("RuntimeError"));
  await python.exec("async def await_callable_reentry(value):\n    return await callable_async_reentry(value)");
  assert.equal(await python.main.await_callable_reentry(41), 42);
  await assert.rejects(async () => await python.exec("callable_failure()"), isPythonError("RuntimeError", failure));
});

it("preserves constructors, keyword arguments and returned JavaScript identity", async () => {
  let latest: unknown;
  function Box(this: { value: number }, value: number, options: { offset?: number } = {}) {
    this.value = value + (options.offset ?? 0);
    latest = this;
  }
  class Counter {
    value: number;
    constructor(value: number) {
      this.value = value;
      latest = this;
    }
  }
  python.main.callable_box = Box;
  python.main.callable_class = Counter;
  await python.exec("constructed_box = callable_box.new(40, offset=2)");
  assert.equal(await python.eval("constructed_box.value"), 42);
  assert.equal(await python.eval("constructed_box"), latest);
  await python.exec("constructed_class = callable_class(42)");
  assert.equal(await python.eval("constructed_class"), latest);
  await python.exec("constructed_class_new = callable_class.new(42)");
  assert.equal(await python.eval("constructed_class_new"), latest);
});

it("allows async callback reentry while synchronous properties service pending calls", async () => {
  python.main.pending_async_reentry = async () => await python.eval<number>("40 + 2");
  await python.exec(`
import threading, time
pending_reentry_ready = threading.Event()
pending_reentry_release = threading.Event()
async def pending_reentry_call():
    pending_reentry_ready.set()
    while not pending_reentry_release.is_set():
        await asyncio.sleep(0.001)
    return await pending_async_reentry()
class PendingReentry:
    @property
    def release(self):
        assert pending_reentry_ready.wait(5)
        pending_reentry_release.set()
        time.sleep(0.1)
        return True
pending_reentry = PendingReentry()
`);
  const pending = python.main.pending_reentry_call();
  assert.equal(await python.eval("pending_reentry_ready.wait(5)"), true);
  const object = python.main.pending_reentry;
  try {
    assert.equal(object.release, true);
    assert.equal(await pending, 42);
  } finally {
    object[Symbol.dispose]();
  }
});

it("rejects a promise returned to a synchronous Python call without unhandled rejection", async () => {
  python.main.callable_promise = () => Promise.reject(new Error("lost synchronous promise"));
  await assert.rejects(async () => await python.exec("callable_promise()"), isPythonError("RuntimeError"));
});

it("returns concurrent futures on Python workers and preserves independent errors", async () => {
  python.main.callable_threaded = (index: number, options: { offset: number }) => {
    if (index % 2 === 0) throw new RangeError("worker callable failed");
    return index + options.offset;
  };
  await python.exec(`
def callable_worker(index):
    future = callable_threaded(index, offset=2)
    assert isinstance(future, concurrent.futures.Future)
    try:
        return future.result()
    except RuntimeError as error:
        return str(error)
`);
  const pool = await (await python.import("concurrent.futures")).ThreadPoolExecutor(kwargs({ max_workers: 8 }));
  try {
    assert.deepEqual(
      await Promise.all(Array.from({ length: 32 }, async (_, index) => Promise.resolve(pool.submit(python.main.callable_worker, index)))),
      Array.from({ length: 32 }, (_, index) => (index % 2 ? index + 2 : "JavaScript RangeError: worker callable failed")),
    );
  } finally {
    await pool.shutdown();
  }
});

it("returns asyncio futures on the caller's independent worker loops", async () => {
  python.main.callable_async = async (value: number) => value + 1;
  await python.exec(`
async def callable_coroutine():
    future = callable_async(41)
    assert isinstance(future, asyncio.Future)
    return await future
def callable_loop_worker():
    return asyncio.run(callable_coroutine())
`);
  assert.equal(await python.main.callable_coroutine(), 42);
  const pool = await (await python.import("concurrent.futures")).ThreadPoolExecutor(kwargs({ max_workers: 4 }));
  try {
    assert.deepEqual(await Promise.all(Array.from({ length: 12 }, async () => Promise.resolve(pool.submit(python.main.callable_loop_worker)))), Array(12).fill(42));
  } finally {
    await pool.shutdown();
  }
});

it("releases wrapper cycles through the existing weakref queue and function registry", async () => {
  const drain = () => {
    const temporary = python.toPython(() => null);
    temporary[Symbol.dispose]();
  };
  await python.exec("gc.collect()");
  drain();
  const before = python.stats().functions;
  python.main.released_callable = () => 42;
  await python.exec("released_callable_weak = weakref.ref(released_callable)\ndel released_callable\ngc.collect()");
  assert.equal(await python.eval("released_callable_weak() is None"), true);
  drain();
  assert.equal(python.stats().functions, before);
});
