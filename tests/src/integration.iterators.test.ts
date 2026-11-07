import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, it } from "node:test";
import { Python, PythonError, byReference, kwargs } from "@node-ctypes/python";

const python = await Python.initialize({ stdin: false });
after(async () => await python.finalize());
await python.exec("import gc, inspect, weakref");

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

it("retains a lazy Python generator, send/close semantics and JavaScript iterator identity", async () => {
  let started = 0;
  let stepped = 0;
  let closed = 0;
  const iterator = {
    next() {
      return { value: ++stepped, done: stepped > 2 };
    },
    return() {
      closed++;
      return { done: true };
    },
  };
  python.main.lazy_source = byReference({
    [Symbol.iterator]() {
      started++;
      return iterator;
    },
  });
  await python.exec("import inspect\nlazy_iterator = iter(lazy_source)\nassert inspect.isgenerator(lazy_iterator)");
  assert.equal(started, 0);
  await python.exec("lazy_iterator.close()\nlazy_iterator = iter(lazy_source)");
  assert.equal(started, 0);
  assert.equal(await python.eval("next(lazy_iterator)"), 1);
  assert.equal(await python.eval("lazy_iterator.send('ignored')"), 2);
  assert.equal(started, 1);
  assert.equal(stepped, 2);
  await python.exec("lazy_iterator.close()");
  await assert.rejects(async () => await python.exec("next(lazy_iterator)"), isPythonError("StopIteration"));
  assert.equal(closed, 0);
});

it("closes failed generators and preserves iterator creation/next error causes", async () => {
  const failure = new RangeError("iterator failed");
  python.main.bad_iterable = byReference({
    [Symbol.iterator]() {
      throw failure;
    },
  });
  await python.exec("bad_iterator = iter(bad_iterable)");
  await assert.rejects(async () => await python.exec("next(bad_iterator)"), isPythonError("RuntimeError", failure));
  await assert.rejects(async () => await python.exec("next(bad_iterator)"), isPythonError("StopIteration"));
  python.main.bad_iterable = byReference({
    [Symbol.iterator]() {
      return {
        next() {
          throw failure;
        },
      };
    },
  });
  await python.exec("bad_iterator = iter(bad_iterable)");
  await assert.rejects(async () => await python.exec("next(bad_iterator)"), isPythonError("RuntimeError", failure));
  await assert.rejects(async () => await python.exec("next(bad_iterator)"), isPythonError("StopIteration"));
});

it("pins the Python source for the generator lifetime and releases it after disposal", async () => {
  for (const finish of ["list(held_iterator)", "held_iterator.close()", "held_iterator.throw(ValueError('stop'))"]) {
    python.main.held_source = byReference([1, 2]);
    await python.exec("import gc, weakref\nheld_weak = weakref.ref(held_source)\nheld_iterator = iter(held_source)\ndel held_source\ngc.collect()");
    assert.equal(await python.eval("held_weak() is not None"), true);
    if (finish.includes("throw")) await python.exec(`try:\n    ${finish}\nexcept ValueError:\n    pass`);
    else await python.exec(finish);
    await python.exec("assert held_iterator.gi_frame is None\ndel held_iterator\ngc.collect()");
    assert.equal(await python.eval("held_weak() is None"), true, finish);
  }
});

it("iterates shared sources from Python workers without changing result ownership", async () => {
  python.main.worker_iterable = byReference([1, 2, 3]);
  await python.exec("def worker_iterate():\n    return sum(worker_iterable)");
  const pool = await (await python.import("concurrent.futures")).ThreadPoolExecutor(kwargs({ max_workers: 8 }));
  try {
    assert.deepEqual(await Promise.all(Array.from({ length: 32 }, async () => Promise.resolve(pool.submit(python.main.worker_iterate)))), Array(32).fill(6));
  } finally {
    await pool.shutdown();
  }
});

it("creates async iterators eagerly but defers next until the coroutine is awaited", async () => {
  let created = 0;
  let stepped = 0;
  const iterator = {
    async next() {
      return { value: ++stepped, done: stepped > 1 };
    },
  };
  python.main.async_source = byReference({
    [Symbol.asyncIterator]() {
      created++;
      return iterator;
    },
  });
  await python.exec("async_iterator = aiter(async_source)\nassert aiter(async_iterator) is async_iterator\npending_next = anext(async_iterator)\nassert inspect.iscoroutine(pending_next)");
  assert.equal(created, 1);
  assert.equal(stepped, 0);
  assert.equal(await python.eval("async_iterator.iterator"), iterator);
  assert.equal(await python.main.pending_next, 1);
  await assert.rejects(Promise.resolve(python.main.async_iterator.__anext__()), isPythonError("StopAsyncIteration"));
  assert.equal(stepped, 2);
});

it("preserves async next errors and remains usable after a failed step", async () => {
  const failure = new RangeError("async next failed");
  let calls = 0;
  python.main.async_errors = byReference({
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (++calls === 1) throw failure;
          if (calls === 2) return Promise.reject(failure);
          return Promise.resolve({ value: 42, done: false });
        },
      };
    },
  });
  await python.exec("error_iterator = aiter(async_errors)");
  await assert.rejects(Promise.resolve(python.main.error_iterator.__anext__()), isPythonError("RuntimeError", failure));
  await assert.rejects(Promise.resolve(python.main.error_iterator.__anext__()), isPythonError("RuntimeError", failure));
  assert.equal(await python.main.error_iterator.__anext__(), 42);
});

it("pins async iterators through pending coroutines and releases them after disposal", async () => {
  python.main.owned_async_source = byReference([1, 2]);
  await python.exec(`
owned_async_iterator = aiter(owned_async_source)
owned_async_weak = weakref.ref(owned_async_iterator)
owned_async_step = anext(owned_async_iterator)
del owned_async_iterator
gc.collect()
assert owned_async_weak() is not None
owned_async_step.close()
del owned_async_step
gc.collect()
assert owned_async_weak() is None
`);
});

it("preserves immediate await setup errors outside a running asyncio loop", async () => {
  python.main.no_loop_promise = Promise.resolve(42);
  await assert.rejects(async () => await python.exec("no_loop_promise.__await__()"), isPythonError("AttributeError"));
});

it("uses the caller's asyncio loop, including independent loops on foreign threads", async () => {
  python.main.loop_promise = Promise.resolve(40);
  python.main.loop_values = byReference([1, 1]);
  await python.exec(`
async def local_protocols():
    return await loop_promise + sum([value async for value in loop_values])
def foreign_loop_protocols():
    import asyncio
    return asyncio.run(local_protocols())
`);
  assert.equal(await python.main.local_protocols(), 42);
  const pool = await (await python.import("concurrent.futures")).ThreadPoolExecutor(kwargs({ max_workers: 4 }));
  try {
    assert.deepEqual(await Promise.all(Array.from({ length: 12 }, async () => Promise.resolve(pool.submit(python.main.foreign_loop_protocols)))), Array(12).fill(42));
  } finally {
    await pool.shutdown();
  }
});

it("retains async early-break behavior without calling JavaScript return", async () => {
  let closed = 0;
  python.main.break_source = byReference({
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.resolve({ value: 42, done: false }),
        return() {
          closed++;
          return Promise.resolve({ done: true });
        },
      };
    },
  });
  await python.exec("async def break_async():\n    async for value in break_source:\n        return value");
  assert.equal(await python.main.break_async(), 42);
  assert.equal(closed, 0);
});

it("preserves shared-promise rejection causes and cancellation without cancelling the promise", async () => {
  let settle!: (value: number) => void;
  python.main.pending_promise = new Promise<number>((resolve) => {
    settle = resolve;
  });
  await python.exec(`
async def await_pending():
    return await pending_promise
async def cancel_pending():
    import asyncio
    task = asyncio.create_task(await_pending())
    await asyncio.sleep(0.01)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        return "cancelled"
`);
  try {
    assert.equal(await python.main.cancel_pending(), "cancelled");
  } finally {
    settle(42);
  }
  assert.equal(await python.main.await_pending(), 42);
  const failure = new RangeError("promise failed");
  const rejected = Promise.reject(failure);
  void rejected.catch(() => {});
  python.main.rejected_promise = rejected;
  await python.exec("async def await_rejected():\n    return await rejected_promise");
  await assert.rejects(Promise.resolve(python.main.await_rejected()), isPythonError("RuntimeError", failure));
  const deadline = Date.now() + 5000;
  while (python.stats().calls !== 0 && Date.now() < deadline) await delay(1);
  assert.equal(python.stats().calls, 0);
});
