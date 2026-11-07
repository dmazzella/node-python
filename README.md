# node-python (`@node-ctypes/python`)

Embed CPython in Node.js with a TypeScript API powered by
[node-ctypes](https://www.npmjs.com/package/node-ctypes).
This standalone ESM package ships compiled JavaScript and declarations.
Python runs in-process, not in a subprocess or sandbox.

## Requirements and installation

- Node.js 24+ and an ESM application.
- Python 3.12+ with a shared library matching Node.js architecture and Python ABI.
- Windows, Linux or macOS.

Windows and macOS installations normally include the shared library. On
Debian/Ubuntu install the matching `libpython3.x` package; with pyenv use
`PYTHON_CONFIGURE_OPTS=--enable-shared`.
Install optional Python dependencies into the selected interpreter's environment.
Neither Python nor its packages are bundled.

```sh
npm install @node-ctypes/python
```

To build from source, run from this directory:

```sh
npm install
npm run build
npm test
npm pack
```

Install the resulting tarball into your application with
`npm install /path/to/node-ctypes-python-0.1.0.tgz`.
The runtime dependency is published `node-ctypes` (`^2.10.0`); no custom native
bridge, core patch or JavaScript worker is required.

## Quick start

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

### Configuration

`Python.initialize({ executable, library, stdin, stdout, stderr, synchronousCallbacks, switchInterval })`
returns the runtime singleton. Options apply to the first initialization.

- `executable`, or `PYTHON`, selects the interpreter; an explicit choice never
  falls back. Otherwise discovery tries installed Python commands.
- `library`, or `PYTHON_LIBRARY`, overrides shared-library discovery. The selected
  interpreter supplies `sys.path`, including virtualenv paths. Each discovery
  probe has a 10-second timeout.
- `stdin: false` leaves standard input to Node.js. `stdout` and `stderr` accept
  `"inherit"` (default), `"node"` or a text callback.
- `synchronousCallbacks: true` enables native callback dispatch during
  interruptible synchronous Python waits. It requires an available SIGURG wakeup
  on POSIX, or Windows Python 3.14+ with its interrupt event available.
  Unsupported configurations fail explicitly; the default is `false`.
- `switchInterval` sets the GIL switch interval in milliseconds
  (`sys.setswitchinterval`). The default is `5`, as in CPython. Every Python call
  acquires the GIL on the Node.js thread, so while Python threads run CPU-bound
  code each call can stall the event loop for several intervals: on Windows we
  measured stalls of 150–250 ms with the default. `0.5` reduced them to under
  50 ms, but slowed two contending CPU-bound Python threads by 40% or more.
  To keep the main thread free without that cost, host Python in a worker
  (`examples/worker.ts`).

Native objects are always enabled; there is no `nativeObjects` mode.
Free-threaded builds require their matching executable and shared library;
an ABI3t compatibility DLL alone does not enable free threading.

## API and execution model

| API                                              | Purpose                                                |
| ------------------------------------------------ | ------------------------------------------------------ |
| `Python.initialize(options)`                     | Initialize the singleton asynchronously                |
| `python.main`, `python.builtins`                 | Live module proxies                                    |
| `python.version`, `.executable`, `.library`      | Selected interpreter information                       |
| `await python.exec(code)`                        | Execute statements in `__main__`                       |
| `await python.eval<T>(expression)`               | Evaluate and deeply convert the result                 |
| `await python.import<T>(name)`                   | Import a live module, including dotted names           |
| `python.module(name, members)`                   | Register JavaScript members as a Python module         |
| `python.toPython<T>(value)`                      | Create an explicitly disposable Python proxy           |
| `python.run(operation, { signal })`              | Await a Python operation or awaitable, with abort      |
| `await python.with(manager, body)` / `asyncWith` | Run a context manager, including exception suppression |
| `python.stats()`                                 | Inspect shared-reference and scheduler counters        |
| `await python.finalize()`                        | Drain accepted native calls and close the runtime      |

Exports also include `PythonError`, `Tuple`, `kwargs`, `byReference` and
`cancellable`. Types and generics describe the dynamic API; they do not validate
Python types at runtime.

**Calls are asynchronous; live access is synchronous.** Python functions, methods,
classes and builtins return Promises, including `await new cls(...)`.
Calls, imports, `exec` and `eval` execute on one Python-owned thread without
occupying a waiting libuv worker. Arguments and results are converted on Node.js.
Attributes, indices, assignment, enumeration, ordinary iteration, conversion and
disposal remain synchronous and can block Node.js. Native initialization and
finalization also run synchronously on the hosting Node.js thread.

Python coroutine results are automatically awaited through a separate asyncio
thread. Async iterators work in both directions. An async JavaScript callback
must be awaited from Python; a synchronous Python callback cannot return a
JavaScript Promise. `cancellable(fn)` adds an `AbortSignal` to callbacks that
cooperate with Python cancellation.

`python.run(operation, { signal })` accepts the Promise of a call, `exec`,
`eval` or `import`, or a Python awaitable, and rejects with `signal.reason`
on abort (`AbortSignal.timeout(ms)` for time limits). A queued operation is
skipped; running Python code receives one `KeyboardInterrupt`, so `finally`
blocks run and `except Exception` does not swallow it. On CPython 3.12 only,
a one-line loop that starts a `try` block (`try:` followed by `while True: ...`)
skips that `finally` when interrupted; put the loop body on its own line.
Native calls are
interrupted only when they return; asyncio work is cancelled. Synchronous proxy
access and JavaScript work cannot be aborted.

### Values, memory and lifetime

- Scalars convert naturally; Python integers outside JavaScript's safe range
  become bigints. Arrays, `Tuple`, objects/Maps and Sets copy to Python containers.
  Dates become UTC datetimes; Temporal conversions require runtime support.
- Other Python objects remain live proxies. `eval()` and `proxy.toJS()` perform
  deep conversion; ordinary call results use shallow conversion. Circular copies
  are rejected; use live proxies or `byReference()` instead.
- Arbitrary JavaScript instances remain shared references. `byReference(value)`
  also shares ordinary containers. Python attributes take precedence over dict keys.
- Buffer/Uint8Array values copy to Python bytes; other typed arrays, ArrayBuffers
  and DataViews expose shared memoryviews. `byReference(buffer)` shares writable
  memory. `proxy.toTypedArray()` requires a C-contiguous Python buffer and copies
  read-only buffers. Do not detach, transfer or resize shared backing memory.
- Release owned proxies with `[Symbol.dispose]()` when practical, including
  `PythonError.exception`. GC is nondeterministic. `PythonError` exposes `type`,
  `traceback`, `exception` and, when available, the original JavaScript `cause`.

Only one JavaScript thread per process may host Python. A Node.js worker can
isolate synchronous access and conversions, but must finalize before terminating.
Wait for application work and Python threads before finalization; do not finalize
inside a Python callback. Repeated finalization is harmless; restart and
subinterpreters are not supported. Never use Python proxies or Python-backed
memory afterward.

Closing rejects new calls and drains accepted native operations, not every
pending coroutine: remaining awaits are rejected during teardown. Cleanup also
runs on normal `beforeExit`; `process.exit()` is not orderly finalization.
Shutdown can wait for Python threads and has no overall timeout.
Execute trusted Python code only.

## Examples and tests

Run examples directly, for example `node examples/basics.ts`.
They cover usage in more detail than this overview:

| Example                                       | Focus                                         |
| --------------------------------------------- | --------------------------------------------- |
| [basics.ts](./examples/basics.ts)             | Values, live objects, errors and conversions  |
| [callbacks.ts](./examples/callbacks.ts)       | JavaScript callbacks and constructors         |
| [threads.ts](./examples/threads.ts)           | Python threads and cross-thread callbacks     |
| [async.ts](./examples/async.ts)               | Await, cancellation and async iteration       |
| [module.ts](./examples/module.ts)             | JavaScript modules and local Python imports   |
| [worker.ts](./examples/worker.ts)             | Hosting Python in a Node.js worker            |
| [cryptography.ts](./examples/cryptography.ts) | Python cryptography integration               |
| [lxml.ts](./examples/lxml.ts)                 | XML parsing, XPath, XSLT and canonicalization |

Optional packages are needed only for the corresponding examples and must be
installed in the selected interpreter. Set `PYTHON` to that executable if it
differs from the one found automatically. The suite regression-tests callbacks
and missing-package diagnostics; other example scenarios are manual.

```sh
npm run typecheck
npm test
npm run test:unit
npm run test:integration
npm run test:types
npm run test:backlog
npm run test:stress
```

`npm test` builds and runs the ordinary suite; integration tests require shared
CPython. Typechecks include sources, examples and test helpers.
`test:backlog` checks queued ownership, every outcome and shutdown under load.
`test:stress` adds a 60-second mixed workload; set `NODE_PYTHON_STRESS_SECONDS`
to change its duration. Both are opt-in, force GC in isolated children and report
memory/latency diagnostics, not performance or leak-certification guarantees.
The runtime does not impose application backpressure.

The [CI workflow](./.github/workflows/ci.yml) runs `npm test` with Python
3.12, 3.13, 3.14, 3.14t and 3.15 on Windows, Linux and macOS. It is discovered only when
this package is a repository root, not while nested in another repository.
For implementation diagrams and ownership invariants, see [FLOWS.md](./FLOWS.md)
(Italian).
