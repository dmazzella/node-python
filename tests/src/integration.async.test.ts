import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, describe, it } from "node:test";
import { Python, cancellable, kwargs } from "@node-ctypes/python";

const python = await Python.initialize({ stdin: false });
after(async () => await python.finalize());
await python.exec(`
import asyncio

async def result():
    await asyncio.sleep(0.03)
    return 42

async def wait_forever():
    await asyncio.sleep(60)

async def numbers():
    for i in range(3):
        await asyncio.sleep(0.001)
        yield i

async def use_node():
    import node_async
    return await node_async.double(21)

async def consume(values):
    return sum([value async for value in values])

async def cancel_node():
    import node_async
    try:
        await asyncio.wait_for(node_async.wait(), 0.05)
    except TimeoutError:
        return 'cancelled'
`);

describe("asyncio and Python threads", () => {
  it("awaits coroutines without blocking the Node.js event loop", async () => {
    let ticked = false;
    let completed = false;
    python.module("node_progress", {
      tick: () =>
        delay(0).then(() => {
          assert.equal(completed, false, "the timer must run while the Python awaitable is still pending");
          ticked = true;
          return 42;
        }),
    });
    await python.exec("async def progress():\n    import node_progress\n    return await node_progress.tick()");
    const result = Promise.resolve(python.main.progress()).then((value: unknown) => {
      completed = true;
      return value;
    });
    assert.equal(await result, 42);
    assert.ok(ticked);
  });

  it("awaits JavaScript promises from Python", async () => {
    python.module("node_async", {
      double: async (value: number) => {
        await delay(1);
        return value * 2;
      },
    });
    assert.equal(await python.main.use_node(), 42);
  });

  it("awaits custom Python awaitables that are not coroutines", async () => {
    await python.exec(`
class CustomAwaitable:
    def __await__(self):
        return result().__await__()

def custom_awaitable():
    return CustomAwaitable()
`);
    assert.equal(await python.main.custom_awaitable(), 42);
    assert.equal(python.stats().awaits, 0);
  });

  it("iterates Python async generators and JavaScript async iterables", async () => {
    const values: number[] = [];
    for await (const value of await python.main.numbers()) values.push(value);
    assert.deepEqual(values, [0, 1, 2]);
    async function* source() {
      yield 10;
      await delay(1);
      yield 20;
    }
    assert.equal(await python.main.consume(source()), 30);
  });

  it("cancels a Python awaitable with an AbortSignal", async () => {
    const controller = new AbortController();
    const result = python.run(python.main.wait_forever(), { signal: controller.signal });
    controller.abort();
    await assert.rejects(result, (error: unknown) => error === controller.signal.reason);
  });

  it("uses the reason of an already-aborted signal", async () => {
    const reason = new Error("cancelled before run");
    const signal = AbortSignal.abort(reason);
    await assert.rejects(python.run(python.main.wait_forever(), { signal }), (error: unknown) => error === reason);
  });

  it("closes a coroutine cancelled before its first asyncio step", async () => {
    await python.exec(`
cancel_coroutine_started = False

def cancel_first_step(loop, coroutine, **options):
    task = asyncio.Task(coroutine, loop=loop, **options)
    task.cancel()
    return task

async def arm_cancel_before_start():
    global cancel_test_loop, cancel_previous_factory
    cancel_test_loop = asyncio.get_running_loop()
    cancel_previous_factory = cancel_test_loop.get_task_factory()
    cancel_test_loop.set_task_factory(cancel_first_step)

async def cancel_before_start():
    global cancel_coroutine_started
    cancel_coroutine_started = True
    await asyncio.sleep(60)

cancel_pending_coroutine = cancel_before_start()
`);
    await python.main.arm_cancel_before_start();
    try {
      const reason = new Error("cancel before the first asyncio step");
      using coroutine = python.main.cancel_pending_coroutine;
      await assert.rejects(python.run(coroutine, { signal: AbortSignal.abort(reason) }), (error: unknown) => error === reason);
      await python.exec("cancel_test_loop.call_soon_threadsafe(cancel_test_loop.set_task_factory, cancel_previous_factory)");
      await python.main.result();
      assert.equal(await python.eval("cancel_coroutine_started"), false);
      assert.equal(await python.eval("cancel_pending_coroutine.cr_frame is None"), true, "cancellation must close the original coroutine, not only its wrapper");
      assert.equal(python.stats().awaits, 0);
    } finally {
      await python.exec("cancel_test_loop.call_soon_threadsafe(cancel_test_loop.set_task_factory, cancel_previous_factory)");
      await python.main.result();
      await python.exec("cancel_pending_coroutine.close()\ndel cancel_pending_coroutine");
    }
  });

  it("does not change an already-completed result when its signal is aborted later", async () => {
    const target = python.main.result();
    assert.equal(await target, 42);
    const controller = new AbortController();
    assert.equal(await python.run(target, { signal: controller.signal }), 42);
    controller.abort(new Error("too late"));
    assert.equal(await target, 42);
  });

  it("settles once when cancellation races with completion and drains pending awaits", async () => {
    await python.exec("async def immediate():\n    return 42");
    for (let i = 0; i < 20; i++) {
      const controller = new AbortController();
      const reason = new Error(`race ${i}`);
      const work = python.run<number>(python.main.immediate(), { signal: controller.signal });
      const abort = setImmediate(() => controller.abort(reason));
      try {
        assert.equal(await work, 42);
      } catch (error) {
        assert.equal(error, reason);
      } finally {
        clearImmediate(abort);
      }
    }
    const deadline = Date.now() + 5_000;
    while (python.stats().awaits !== 0 && Date.now() < deadline) await delay(1);
    assert.equal(python.stats().awaits, 0);
    assert.equal(python.stats().calls, 0);
    assert.equal(await python.main.result(), 42);
  });

  it("propagates Python cancellation to cancellable JavaScript functions", async () => {
    let aborted = false;
    python.module("node_async", {
      wait: cancellable(async (signal: AbortSignal) => {
        try {
          await delay(60_000, undefined, { signal });
        } finally {
          aborted = signal.aborted;
        }
      }),
    });
    assert.equal(await python.main.cancel_node(), "cancelled");
    assert.ok(aborted);
  });

  it("awaits futures and serves callbacks from Python threads", async () => {
    python.module("thread_callbacks", { double: (value: number) => value * 2 });
    await python.exec("def thread_work():\n    import thread_callbacks\n    return thread_callbacks.double(21).result()");
    const pool = await (await python.import("concurrent.futures")).ThreadPoolExecutor(kwargs({ max_workers: 1 }));
    try {
      assert.equal(await pool.submit(python.main.thread_work), 42);
    } finally {
      await pool.shutdown();
    }
  });

  it("supports async context managers", async () => {
    await python.exec(`
from contextlib import asynccontextmanager
closed = False

@asynccontextmanager
async def manager():
    global closed
    try:
        yield 21
    finally:
        closed = True
`);
    assert.equal(await python.asyncWith(await python.main.manager(), async (value: number) => value * 2), 42);
    assert.equal(await python.eval("closed"), true);
  });

  it("rejects unconvertible JavaScript results without losing the Python future", async () => {
    python.main.unconvertible_result = () => Symbol("not a Python value");
    await python.exec(`
async def await_unconvertible():
    try:
        await unconvertible_result()
    except RuntimeError as error:
        return "Cannot convert" in str(error)
    raise AssertionError("unconvertible result was accepted")
`);
    assert.equal(await python.main.await_unconvertible(), true);
    assert.equal(python.stats().calls, 0);
    assert.equal(python.stats().awaits, 0);
  });
});
