---
title: Errors and limits
---

# Errors and limits

## `PythonError`

Python exceptions surface in JavaScript as instances of `PythonError` (subclass of `Error`):

- `error.type` — Python exception class name (e.g. `"ZeroDivisionError"`, `"ValueError"`, `"ModuleNotFoundError"`)
- `error.message` — `${type}: ${str(exc)}`
- `error.traceback` — formatted Python traceback (also appended to `error.stack`)
- `error.exception` — live `PythonObject` proxy for the Python exception instance (dispose with `error.exception[Symbol.dispose]()` when catching and discarding it)
- `error.cause` — when an exception originated in a JavaScript callback, passed through Python, and returned to JavaScript, `error.cause` preserves the exact original JavaScript error object!

Conversely, if a JavaScript callback catches a `PythonError` and rethrows it (or throws a new JS `Error`), `@node-ctypes/python` restores the original Python exception type (or wraps the JS error in a Python `RuntimeError` tagged with the original JS error for round-trip `cause` recovery).

## Compatibility and limits

- **In-process execution**: Python runs inside the Node.js process without sandboxing. Execute trusted Python code only.
- **One host per process, no restart**: CPython can be initialized once per process and cannot be re-initialized after `finalize()`. Subinterpreters are not supported.
- **Single FIFO executor**: asynchronous Python calls execute in order on one native thread. Avoid flooding the executor with thousands of tiny `Promise.all` calls; batch work in Python or host Python inside a Node.js worker ([examples/worker.ts](../examples/worker.ts)).
- **Synchronous live access**: attribute access, indexing, `for...of`, `toJS()` and `toTypedArray()` run synchronously on the hosting thread while holding the GIL.
- **Async callbacks from synchronous Python**: a JavaScript function returning a `Promise` cannot be returned to synchronous Python code (raises `TypeError`); `await` it in a Python coroutine instead.
- **No `finalize()` inside callbacks**: never call `python.finalize()` while executing inside a Python callback; wait for application tasks and custom Python threads to finish first.
- **Shared memory invariants**: do not detach, transfer or resize a JavaScript `ArrayBuffer` or Python buffer while it is shared across the language boundary.
- **CPython 3.12 one-line `try` loop**: on CPython 3.12, putting `while True: pass` on one line as the first statement of a `try:` block can skip `finally:` when interrupted by `PyThreadState_SetAsyncExc`; write the loop body on its own line.
