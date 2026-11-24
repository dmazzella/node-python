---
title: Getting started
---

# Getting started

## Installation

```sh
npm install @node-ctypes/python
```

`@node-ctypes/python` is a standalone ESM package with TypeScript declarations powered by [node-ctypes](https://www.npmjs.com/package/node-ctypes). It requires no custom native addon or C++ build of its own. Python runs **in-process**, not in a subprocess or sandbox — execute trusted Python code only.

## Requirements

- **Node.js 24+** (ESM).
- **CPython 3.12+** built with a shared library matching Node.js's architecture and Python ABI (including free-threaded builds such as `3.13t` and `3.14t`).
- **Windows, Linux or macOS** (x64 and ARM64).

Windows and macOS Python installations normally ship the shared library automatically. On Debian/Ubuntu, install the matching `libpython3.x` package; with `pyenv`, build with `PYTHON_CONFIGURE_OPTS=--enable-shared`. Neither Python nor third-party Python packages are bundled — install Python packages into the selected interpreter's environment (virtual environments are supported automatically through the probed `sys.path`).

## First program

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

## Configuration

`Python.initialize(options)` initializes and returns the process-wide runtime singleton. Options apply to the first initialization:

| Option                 | Type / Default                                              | Purpose                                                                                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `executable`           | `string` (default: `$PYTHON`, then `python3`/`python`/`py`) | Selects the Python interpreter; an explicit path never falls back. The interpreter provides `sys.path` (including venvs). Each probe times out after 10 s.                                                                       |
| `library`              | `string` (default: `$PYTHON_LIBRARY`, else auto-detected)   | Explicit path to `python3xx.dll` / `libpython3.x.so` / `libpython3.x.dylib`; must match the selected interpreter's major.minor version.                                                                                          |
| `stdin`                | `boolean` (default: `true`)                                 | `false` sets `sys.stdin = None` so Python does not consume standard input intended for Node.js.                                                                                                                                  |
| `stdout` / `stderr`    | `"inherit" \| "node" \| "console" \| ((text) => void)`      | `"inherit"` (default) writes to process FDs; `"node"` routes through `process.stdout`/`stderr` in order with `console.log`; `"console"` emits whole lines to `console.log`/`console.error`; a function receives raw text chunks. |
| `synchronousCallbacks` | `boolean` (default: `false`)                                | Enables native callback dispatch during interruptible synchronous Python waits (requires `SIGURG` on POSIX or Windows Python 3.14+).                                                                                             |
| `switchInterval`       | `number` ms (default: `5`)                                  | Sets `sys.setswitchinterval(ms / 1000)`. Smaller values (e.g. `0.5`) reduce event-loop stalls under CPU-bound Python threads at the cost of lower contended thread throughput.                                                   |

Without an attached console (such as an Electron renderer or a packaged Windows GUI app), Python's `sys.stdout` and `sys.stderr` are `None` and `"inherit"` discards output like `pythonw`: pass `"console"` or a logging callback instead.

## Building from source

```sh
npm install
npm run build
npm test
```

See [Building, testing and internals](contributing.md) for mirror-mode tests, stress tests, Electron checks and docs generation.
