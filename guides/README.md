---
title: Guides
children:
  - ./getting-started.md
  - ./execution-model.md
  - ./values-and-memory.md
  - ./callbacks-and-modules.md
  - ./async-and-cancellation.md
  - ./errors.md
  - ./electron-and-free-threading.md
  - ./contributing.md
---

# Guides

- [Getting started](getting-started.md) — installation, requirements, interpreter discovery and `Python.initialize()` options
- [Execution model](execution-model.md) — the Python executor, synchronous live access, worker hosting, `stats()` and `finalize()`
- [Values, memory and lifetime](values-and-memory.md) — conversions, `Tuple`, `kwargs`, `Date` and `Temporal`, `byReference()`, shared buffers and disposal
- [Callbacks, modules and JsProxy](callbacks-and-modules.md) — JavaScript functions, classes, `python.module()`, `JsProxy` and cross-thread callbacks
- [Async, cancellation and context managers](async-and-cancellation.md) — `asyncio`, bidirectional async iterators, `python.run()`, `cancellable()`, `with()` and `asyncWith()`
- [Errors and limits](errors.md) — `PythonError`, exception propagation, `KeyboardInterrupt` and runtime limits
- [Electron and free-threaded Python](electron-and-free-threading.md) — Electron main/renderer integration, mirror mode and `Py_GIL_DISABLED` builds (`3.13t` / `3.14t`)
- [Building, testing and internals](contributing.md) — test suites, mirror-mode and stress tests, CI and release workflow

The [examples](../examples/README.md) are runnable programs built on these APIs.
