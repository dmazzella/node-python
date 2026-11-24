---
title: Async, cancellation and context managers
---

# Async, cancellation and context managers

## Interoperating with `asyncio`

Python coroutines, `asyncio.Task`s, `concurrent.futures.Future`s and custom awaitables integrate directly with JavaScript `await`:

- Calling a Python `async def` function automatically schedules the returned coroutine on a dedicated background Python `asyncio` event loop thread and resolves a JavaScript `Promise`.
- Any Python object returned by a coroutine is exposed as a **public async proxy** (its methods continue to return `Promise`s on the executor, matching synchronous calls).
- Conversely, JavaScript `Promise`s passed to Python can be awaited directly inside Python `async def` coroutines.

```typescript
await python.exec(`
import asyncio

async def fetch_double(js_fetch, key):
    value = await js_fetch(key)
    await asyncio.sleep(0.01)
    return value * 2
`);

const result = await python.main.fetch_double(async (key: string) => key.length * 10, "abc");
console.log(result); // 60
```

## Bidirectional async iterators

- **JavaScript `for await` over Python async iterables**: iterates Python `async def` generators and `__aiter__` / `__anext__` objects; breaking out of the loop early calls `aclose()` automatically.
- **Python `async for` over JavaScript async iterables**: `JsProxy` exposes `__aiter__` / `__anext__` for any JS object implementing `Symbol.asyncIterator` (or `Symbol.iterator`).

```typescript
await python.exec(`
async def ticker(n):
    for i in range(n):
        await asyncio.sleep(0.01)
        yield i
`);

for await (const tick of await python.eval("ticker(3)")) {
  console.log(tick); // 0, 1, 2
}
```

## Cancellation

### Aborting Python from JavaScript (`python.run`)

`python.run(operation, { signal })` awaits any Python call promise (`exec`, `eval`, `import`, function call) or Python awaitable and rejects with `signal.reason` when aborted (e.g. `AbortSignal.timeout(1000)`):

```typescript
await python.run(python.main.solve(puzzle), {
  signal: AbortSignal.timeout(1_000),
});
```

- **Queued operation**: skipped immediately before execution starts.
- **Running synchronous Python code**: receives one asynchronous `KeyboardInterrupt` via `PyThreadState_SetAsyncExc`, so `finally` blocks run and `except Exception` does not swallow it. Native C extensions are interrupted once they return to Python bytecode.
- **Running `asyncio` work**: cancels the underlying future / coroutine.
- Synchronous proxy property reads and pure JavaScript work cannot be aborted.

> **CPython 3.12 note:** On CPython 3.12 only, a single-line loop immediately starting a `try:` block (`try:` followed by `while True: ...` on one line) skips its `finally:` on an async interrupt. Put the loop body on its own line.

### Cooperating with Python cancellation (`cancellable`)

Wrap a JavaScript callback with `cancellable(fn)` to receive an `AbortSignal` as its final argument — aborted automatically when Python cancels the awaiting coroutine (for example via `asyncio.wait_for` timeout) or when `python.finalize()` runs:

```typescript
import { cancellable } from "@node-ctypes/python";

const sleep = cancellable(async (ms: number, signal: AbortSignal) => {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
});
```

## Context managers (`with` and `asyncWith`)

Run Python context managers (`__enter__`/`__exit__`) and asynchronous context managers (`__aenter__`/`__aexit__`), including exception forwarding and suppression:

```typescript
const lock = await (await python.import("threading")).Lock();
await python.with(lock, async () => {
  console.log(await lock.locked()); // true
});

const suppress = await (await python.import("contextlib")).suppress(python.builtins.ZeroDivisionError);
await python.with(suppress, async () => {
  await python.eval("1 / 0"); // suppressed -> resolves to undefined
});
```

See [examples/async.ts](../examples/async.ts) for a complete runnable demo.
