---
title: Execution model
---

# Execution model

**Calls are asynchronous; live access is synchronous.** Python functions, methods, classes and builtins return `Promise`s — including constructors (`await new cls(...)`) — and run sequentially in FIFO order on a single dedicated native thread (a `node-ctypes` `Executor`), without occupying a libuv worker thread.

| Asynchronous (`Promise`)                                  | Synchronous (on the hosting Node.js thread)                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `python.exec()`, `python.eval()`, `python.import()`       | Attribute reads/writes (`obj.attr`), indexing (`obj[i]`), `in`, `Object.keys()`       |
| Calling Python functions, methods, classes (`await fn()`) | Ordinary iteration (`for...of`), `toJS()`, `toJSON()`, `toTypedArray()`, `toString()` |
| `python.with()`, `python.asyncWith()`, `python.run()`     | `python.toPython()`, `python.module()`, `python.stats()`, `[Symbol.dispose]()`        |
| `for await` over Python async iterators                   | `Python.initialize()` native startup and `Py_FinalizeEx()` during `finalize()`        |

## Batching work and worker threads

Arguments and results are converted on the hosting Node.js thread while holding the GIL. Submitting thousands of individual calls in a tight `Promise.all` loop holds the Node.js thread during submission and conversion — prefer passing a batch of data to a single Python call, or host Python inside a dedicated Node.js `worker_threads` worker (see [examples/worker.ts](../examples/worker.ts)).

### GIL contention and `switchInterval`

On standard GIL builds of CPython, every Python call acquires the GIL on the hosting Node.js thread during argument/result conversion. While CPU-bound Python threads contend for the GIL, each call can stall the event loop for several switch intervals:

- With CPython's default `switchInterval: 5` (5 ms), stalls of 150–250 ms can occur on Windows under heavy Python thread contention.
- Lowering `switchInterval: 0.5` brings stalls under ~50 ms, at the cost of slowing two contending CPU-bound Python threads by ~40%.
- Hosting Python in a Node.js worker isolates the main thread completely without lowering Python thread throughput.

## Single host per process

CPython allows only one interpreter host per OS process. `@node-ctypes/python` enforces this across worker threads using a native process-scoped lock (`CreateMutexW` on Windows, `sem_open` on POSIX). A Node.js worker can host Python cleanly, provided it calls `await python.finalize()` before terminating.

## Diagnostics and finalization

### `python.stats()`

`python.stats()` returns live cross-language reference counters to detect leaks in tests and long-running services:

```typescript
const { proxies, functions, objects, awaits, calls } = python.stats();
```

- `proxies`: live `PyObject` proxies in JavaScript
- `functions`: JavaScript functions retained by Python callables
- `objects`: JavaScript objects retained by Python `JsProxy` instances
- `awaits`: pending Python awaitables on the asyncio loop
- `calls`: pending cross-thread JavaScript calls from Python threads

### `await python.finalize()`

- Drains accepted native executor calls, cancels running `cancellable()` callbacks, shuts down the asyncio background loop, closes the executor thread, and runs `Py_FinalizeEx()` on the hosting thread.
- Rejects new calls immediately once closing begins; remaining pending coroutines reject during teardown.
- Runs automatically on a normal Node.js `beforeExit`. A forced `process.exit()` abandons native teardown instead of running `Py_FinalizeEx()`.
- Wait for application work and custom Python threads before calling `finalize()`, and never call `finalize()` from inside a Python callback.
- Repeated calls to `finalize()` are harmless; restarting CPython in the same process after finalization is not supported. Never use surviving Python proxies or Python-backed typed arrays after finalization.
