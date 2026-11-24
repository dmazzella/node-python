# node-python (`@node-ctypes/python`)

[![npm version](https://img.shields.io/npm/v/@node-ctypes/python.svg)](https://www.npmjs.com/package/@node-ctypes/python)
[![npm downloads](https://img.shields.io/npm/dm/@node-ctypes/python.svg)](https://www.npmjs.com/package/@node-ctypes/python)
[![Python](https://img.shields.io/badge/python-3.12%20%7C%203.13%20%7C%203.14%20%7C%203.14t%20%7C%203.15-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![CI](https://github.com/dmazzella/node-python/actions/workflows/ci.yml/badge.svg)](https://github.com/dmazzella/node-python/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Typed embedded CPython for Node.js**, powered by
[node-ctypes](https://www.npmjs.com/package/node-ctypes).
Python runs in-process (not in a subprocess or sandbox) with zero custom native addon to compile.

- **Node.js 24+**, ESM, TypeScript declarations.
- **CPython 3.12+**, including **free-threaded builds (`3.13t` / `3.14t`, `Py_GIL_DISABLED`)** on Windows, Linux and macOS (x64 & ARM64).
- **Non-blocking by default**: Python calls, `exec`, `eval` and `import` run on a dedicated native `Executor` thread, with bidirectional `asyncio`, async iterators, `AbortSignal` cancellation, shared memoryviews and native `JsProxy` objects.

---

## Quick start

```sh
npm install @node-ctypes/python
```

```typescript
import { Python, kwargs } from "@node-ctypes/python";

const python = await Python.initialize({ stdin: false, stdout: "node", stderr: "node" });
try {
  const math = await python.import("math");
  console.log(await math.sqrt(81)); // 9

  await python.exec("def add(a, b): return a + b");
  console.log(await python.main.add(20, 22)); // 42

  const json = await python.import("json");
  console.log(await json.dumps({ b: 2, a: 1 }, kwargs({ sort_keys: true })));

  python.module("node", { greet: (name: string) => `Hello ${name}` });
  await python.exec("import node\nprint(node.greet('Python'))");
} finally {
  await python.finalize();
}
```

To build from source, see [Getting started](guides/getting-started.md#building-from-source).

## Supported platforms

| Operating system | x64 | ARM64 |
| ---------------- | --- | ----- |
| Windows          | ✅  | ✅    |
| macOS            | ✅  | ✅    |
| Linux            | ✅  | ✅    |

Node.js 24 or later and shared CPython 3.12+ (including free-threaded builds). Verified in Electron and under `NODE_CTYPES_NO_EXTERNAL_BUFFERS=1` (mirror mode).

---

## Guides

- [Getting started](guides/getting-started.md) — installation, requirements, interpreter discovery and `Python.initialize()` options
- [Execution model](guides/execution-model.md) — the Python executor, synchronous live access, worker hosting, `stats()` and `finalize()`
- [Values, memory and lifetime](guides/values-and-memory.md) — conversions, `Tuple`, `kwargs`, `Date` and `Temporal`, `byReference()`, shared buffers and disposal
- [Callbacks, modules and JsProxy](guides/callbacks-and-modules.md) — JavaScript functions, classes, `python.module()`, `JsProxy` and cross-thread callbacks
- [Async, cancellation and context managers](guides/async-and-cancellation.md) — `asyncio`, bidirectional async iterators, `python.run()`, `cancellable()`, `with()` and `asyncWith()`
- [Errors and limits](guides/errors.md) — `PythonError`, exception propagation, `KeyboardInterrupt` and runtime limits
- [Electron and free-threaded Python](guides/electron-and-free-threading.md) — Electron main/renderer integration, mirror mode and `Py_GIL_DISABLED` builds (`3.13t` / `3.14t`)
- [Building, testing and internals](guides/contributing.md) — test suites, mirror-mode and stress tests, CI and release workflow

Implementation diagrams and ownership invariants (in Italian): [FLOWS.md](FLOWS.md).

---

## Examples

Runnable TypeScript examples live in `examples/`; see the [index](examples/README.md).

- [basics.ts](examples/basics.ts) — values, live proxies, errors, conversions and context managers
- [callbacks.ts](examples/callbacks.ts) — JavaScript callbacks, constructors and `JsProxy`
- [threads.ts](examples/threads.ts) — Python threads and cross-thread JavaScript callbacks
- [async.ts](examples/async.ts) — `asyncio`, `python.run()` cancellation and async iterators
- [module.ts](examples/module.ts) — JavaScript modules (`python.module`) and local Python imports
- [worker.ts](examples/worker.ts) — hosting CPython inside a Node.js worker
- [cryptography.ts](examples/cryptography.ts) — Python `cryptography` integration
- [lxml.ts](examples/lxml.ts) — XML parsing, XPath, XSLT and canonicalization

---

## License

[MIT](LICENSE).
