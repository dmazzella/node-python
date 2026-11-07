// Copyright (c) 2026 Damiano Mazzella. MIT License (see LICENSE).
import { inspect } from "node:util";
import { addressof, byref, memmove, array, EXTERNAL_BUFFERS, c_char_p, c_void_p, c_int, c_ssize_t, c_uint8, threadSafeCallback } from "node-ctypes";
import { API, MIN_PYTHON, Py_file_input, Py_eval_input, METH_VARARGS, METH_KEYWORDS, PyMethodDef, TYPES } from "./native.ts";
import type { PythonLibrary } from "./native.ts";
import { PythonBootstrap } from "./bootstrap.ts";
import { PythonScheduler } from "./scheduler.ts";
import { PythonPlatform } from "./platform.ts";
import { PythonConversions } from "./conversions.ts";
import { PythonBuffers } from "./buffers.ts";
import { PythonExecutor } from "./executor.ts";
import type { Cancellable } from "./executor.ts";
import { NativeObjects, nativeSlot } from "./objects.ts";
import type { NativeSlot } from "./objects.ts";
import { probeInterpreter, loadLibrary } from "./interpreter.ts";
import { claimHost, releaseHost } from "./host.ts";
import { Temporal, temporalFields } from "./temporal.ts";
import { PythonError, Tuple, ByReference, Kwargs, CANCELLABLE, PY_TYPE, pythonError, isClass, typeName, FORMATS } from "./values.ts";
import type { PythonOptions, InternalPythonObject as PythonObject, PythonObject as PublicPythonObject, RunOptions, PythonStats, PythonTypedArray, InterpreterInfo, StreamOptions } from "./types.ts";
import type { ThreadSafeCallbackWrapper } from "node-ctypes";

type Pointer = bigint | null;
type RuntimeState = "initializing" | "running" | "closing" | "finalized" | "failed";
interface ProxyState {
  ptr: Pointer;
  public: boolean;
  promise?: Promise<unknown>;
  future?: PythonObject;
}
interface FunctionEntry {
  fn: Function & { [CANCELLABLE]?: boolean };
  def: PyMethodDef;
  isClass: boolean;
}
interface AwaitEntry {
  future: PythonObject | null;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}
interface CallControl extends Cancellable {
  awaitable?: PythonObject;
  aborted: boolean;
}
interface TypedArrayConstructor {
  readonly BYTES_PER_ELEMENT: number;
  new (length: number): PythonTypedArray;
  new (buffer: ArrayBufferLike, byteOffset: number, length: number): PythonTypedArray;
}
const errorProperty = (error: unknown, key: PropertyKey): unknown => Reflect.get(Object(error), key);
// WeakMap reads accept primitive keys at runtime; only writes require objects.
class ProxyStates extends WeakMap<object, ProxyState> {
  override get(key: unknown): ProxyState | undefined {
    return super.get(key as object);
  }
  override has(key: unknown): boolean {
    return super.has(key as object);
  }
}
const DONE = Symbol("done");
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function") && typeof Reflect.get(value, "then") === "function";
}
// Channel events emitted by the Python caller-thread adapters.
const EVENT_DONE = 0;
const EVENT_CALL = 1;
const EVENT_CANCEL = 2;
const isIndex = (prop: string) => /^-?(0|[1-9]\d*)$/.test(prop);

// Function.prototype members used by JavaScript code on callables (handler.apply(this, args), fn.bind()).
const FUNCTION_MEMBERS = new Set(["apply", "call", "bind", "length", "name"]);
let instance: Python | null = null;
let constructing = false;
let initializationFailure: Error | null = null;
let initialization: Promise<Python> | null = null;

/**
 * The embedded Python interpreter. CPython can be initialized once per
 * process: use `Python.initialize()`.
 */
export class Python {
  #api!: PythonLibrary;
  #releaseLibraryPath: (() => void) | undefined;
  #types: Record<string, bigint> = {};
  #none!: bigint;
  #true!: bigint;
  #runtimeError!: Pointer;
  #attributeError!: Pointer;
  #mainThread!: number | bigint; // threading.get_ident() of the Node.js main thread
  #depth = 0; // nested JavaScript → Python calls holding the GIL
  #asyncCallbackDepth: number | null = null;
  #gilState = 0;
  #threadState: Pointer = null;
  #state: RuntimeState = "initializing";
  #ownsInterpreter = false;
  #executor!: PythonExecutor;
  #pending = new Set<Promise<unknown>>();
  #closing: Promise<void> | null = null;
  #callControls = new WeakMap<Promise<unknown>, CallControl>();
  #nativeFinalizing = false;
  #beforeExitHandler = () => {
    void this.finalize().catch((error: unknown) => {
      console.error("Python finalization failed:", error);
      process.exitCode = 1;
    });
  };
  #exitHandler = () => {
    // Forced process.exit() cannot await native cleanup or serve callbacks.
    if (this.#depth > 0) {
      // Abandonment errors must unwind with the Python thread still attached.
      this.#executor?.abandon();
      this.#api.PyEval_SaveThread();
    } else if (this.#pending.size > 0) {
      this.#withGIL(() => this.#executor?.abandon());
    }
    this.#state = "finalized";
  };
  #states = new ProxyStates(); // proxy and proxy target → { ptr }
  #registry!: FinalizationRegistry<ProxyState>;
  #releasedProxies: bigint[] = [];
  #handler!: ProxyHandler<PythonObject>;
  #functions = new Map<bigint, FunctionEntry>(); // id → { fn, def }
  #nextId = 1n;
  #jsErrors = new Map<number, unknown>();
  #trampoline!: NativeSlot;
  #bootstrap!: PythonBootstrap;
  #scheduler: PythonScheduler | undefined;
  #platform!: PythonPlatform;
  #conversions!: PythonConversions;
  #buffers!: PythonBuffers;
  #drainScheduled = false;
  #awaits = new Map<number, AwaitEntry>(); // token → { future, resolve, reject }
  #controllers = new Map<number, AbortController>(); // token → AbortController of a running cancellable() call
  #objects = new Map<bigint, { value: object; count: number }>(); // id → { value, count }: JavaScript objects used by Python (JsProxy)
  #objectIds = new WeakMap<object, bigint>(); // object → id
  #jsProxyType!: Pointer;
  #nativeObjects: NativeObjects | undefined;
  #synchronousCallbacks: boolean;
  #switchInterval: number;
  #functionType!: Pointer; // types.FunctionType: JavaScript functions are wrapped in Python functions
  #javascriptCode!: Pointer; // code object of those wrappers
  #keep = new WeakMap<ArrayBufferLike, unknown>(); // ArrayBuffer of Python memory → holder that pins it
  #busy = new Int32Array(1); // 1 while the main thread runs Python code (read by Python threads)
  #proxies = 0; // live PyObject proxies
  #nextToken = 1;
  #channel: ThreadSafeCallbackWrapper | null = null; // threadSafeCallback woken by Python threads (see #openChannel)
  #main!: PythonObject;
  #builtins!: PythonObject;
  #publicMain: PublicPythonObject | undefined;
  #publicBuiltins: PublicPythonObject | undefined;
  version!: string;
  executable!: string;
  library!: string;

  get #finalized() {
    return this.#state === "finalized" || this.#state === "failed";
  }

  /**
   * Initialize the embedded interpreter, or return the running one.
   *
   * @param {Object} [options]
   * @param {string} [options.executable] - Python interpreter whose library and environment are used (default: $PYTHON, python3, python, py)
   * @param {string} [options.library] - Explicit path of the Python shared library (default: $PYTHON_LIBRARY); same version as the interpreter
   * @param {boolean} [options.stdin=true] - false: Python does not read the process stdin (sys.stdin is None), left to Node.js
   * @param {"inherit"|"node"|Function} [options.stdout="inherit"] - sys.stdout: the process stdout ("inherit"), process.stdout of Node.js, in order with console.log ("node"), or a function receiving the text
   * @param {"inherit"|"node"|Function} [options.stderr="inherit"] - sys.stderr, as stdout
   * @param {boolean} [options.synchronousCallbacks=false] - serve native callbacks during interruptible synchronous Python waits
   * @param {number} [options.switchInterval=5] - GIL switch interval in milliseconds (sys.setswitchinterval), as in CPython; a smaller value (0.5) keeps the Node.js event loop responsive while Python threads run CPU-bound code, at the cost of slower contended Python threads
   * @returns {Promise<Python>}
   */
  static initialize(options: PythonOptions = {}): Promise<Python> {
    if (initializationFailure) return Promise.reject(new Error("Python initialization previously failed after starting CPython and cannot be initialized again in this process", { cause: initializationFailure }));
    if (initialization) return initialization;
    if (instance) {
      if (instance.#finalized) return Promise.reject(new Error("Python has been finalized and cannot be initialized again in this process"));
      if (instance.#state === "closing") return Promise.reject(new Error("Python is closing"));
      return Promise.resolve(instance);
    }
    constructing = true;
    try {
      const runtime = new Python(options);
      initialization = runtime
        .#start(options)
        .then(() => {
          instance = runtime;
          return runtime;
        })
        .finally(() => {
          initialization = null;
        });
      return initialization;
    } catch (error) {
      return Promise.reject(error);
    } finally {
      constructing = false;
    }
  }

  constructor(options: PythonOptions = {}) {
    if (!constructing) throw new TypeError("Use Python.initialize()");
    if ("nativeObjects" in options) throw new TypeError("options.nativeObjects has been removed: native objects are always enabled; use options.synchronousCallbacks for interruptible synchronous waits");
    const { executable, library = process.env.PYTHON_LIBRARY, stdin = true, stdout = "inherit", stderr = "inherit", synchronousCallbacks = false, switchInterval = 5 } = options;
    for (const [name, value] of Object.entries({ stdout, stderr })) {
      if (value !== "inherit" && value !== "node" && typeof value !== "function") throw new TypeError(`options.${name} must be "inherit", "node" or a function`);
    }

    if (typeof synchronousCallbacks !== "boolean") throw new TypeError("options.synchronousCallbacks must be a boolean");
    this.#synchronousCallbacks = synchronousCallbacks;
    if (typeof switchInterval !== "number" || !Number.isFinite(switchInterval) || switchInterval <= 0) throw new TypeError("options.switchInterval must be a positive number of milliseconds");
    this.#switchInterval = switchInterval;
    claimHost();
  }

  async #start(options: PythonOptions): Promise<void> {
    const { executable, library = process.env.PYTHON_LIBRARY, stdin = true, stdout = "inherit", stderr = "inherit" } = options;
    try {
      await this.#startInterpreter(executable, library, { stdin, stdout, stderr });
    } catch (error) {
      if (this.#ownsInterpreter) {
        initializationFailure = error instanceof Error ? error : new Error("Python initialization failed", { cause: error });
        this.#state = "closing";
        try {
          await this.#finish("failed");
        } catch (cleanupError) {
          initializationFailure = new AggregateError([error, cleanupError], "Python initialization and cleanup failed");
          throw initializationFailure;
        }
      } else {
        const errors = [error];
        try {
          this.#api?.close();
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
        try {
          this.#releaseLibraryPath?.();
          this.#releaseLibraryPath = undefined;
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
        try {
          releaseHost();
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
        await this.#executor?.close();
        if (errors.length > 1) throw new AggregateError(errors, "Python initialization and cleanup failed");
      }
      throw error;
    }
  }

  async #startInterpreter(executable: string | undefined, library: string | undefined, streams: StreamOptions): Promise<void> {
    const info = await probeInterpreter(executable);
    const [pyMajor, pyMinor] = info.version.split(".").map(Number);
    if (pyMajor < MIN_PYTHON[0] || (pyMajor === MIN_PYTHON[0] && pyMinor < MIN_PYTHON[1])) {
      throw new Error(`${info.executable} is Python ${info.version}: python.js requires Python ${MIN_PYTHON.join(".")}+ (pass another interpreter with Python.initialize({ executable }) or the PYTHON environment variable).`);
    }
    const loaded = loadLibrary(info, library);
    this.#api = loaded.lib;
    this.#releaseLibraryPath = loaded.release;

    // Initialized by other code in the process (another native module).
    if (loaded.lib.Py_IsInitialized()) throw new Error("Python is already initialized in this process by other code");

    /** Python version (e.g. "3.12.8"). */
    this.version = info.version;
    /** Interpreter whose environment (sys.path, virtual environment) is used. */
    this.executable = info.executable;
    /** Loaded shared library. */
    this.library = loaded.library;

    const lib = loaded.lib;
    // Opaque object addresses: do not assume CPython's object-header layout.
    for (const name of TYPES) this.#types[name] = addressof(c_uint8.in_dll(lib, name));
    this.#none = addressof(c_uint8.in_dll(lib, "_Py_NoneStruct"));
    this.#true = addressof(c_uint8.in_dll(lib, "_Py_TrueStruct"));
    this.#runtimeError = c_void_p.in_dll(lib, "PyExc_RuntimeError").value;
    this.#attributeError = c_void_p.in_dll(lib, "PyExc_AttributeError").value;

    // Without PYTHONHOME an embedded Python derives its prefix from the node
    // executable; on Windows it is found from the DLL location.
    const setHome = process.platform !== "win32" && process.env.PYTHONHOME === undefined;
    if (setHome) process.env.PYTHONHOME = info.base_prefix;
    try {
      this.#api.Py_InitializeEx(0);
      this.#ownsInterpreter = true;
      this.#threadState = this.#api.PyEval_SaveThread();
    } finally {
      if (setHome) delete process.env.PYTHONHOME;
    }

    this.#executor = this.#withGIL(
      () =>
        new PythonExecutor(
          this.#api,
          (ptr) => this.#check(ptr),
          (fn) => this.#withGIL(fn, true),
          (outcome) => this.#consumeOutcome(outcome),
        ),
    );
    for (const name of [
      "threading",
      "types",
      "weakref",
      "collections.abc",
      "numbers",
      "datetime",
      "zoneinfo",
      "operator",
      "traceback",
      "ctypes",
      "inspect",
      "functools",
      "queue",
      "itertools",
      "io",
      "asyncio",
      "concurrent.futures",
      "signal",
      "time",
      "warnings",
    ]) {
      const module = await this.#nativeCall("PyImport_ImportModule", [name]);
      this.#withGIL(() => this.#api.Py_DecRef(module));
    }
    this.#withGIL(() => this.#setup(info, streams));
    await this.#executeSource("__import__('_node_ctypes')._execution[0] = __import__('threading').get_ident()", Py_file_input, false, true);

    this.#state = "running";
    process.once("exit", this.#exitHandler);
    process.once("beforeExit", this.#beforeExitHandler);
  }

  #setup(info: InterpreterInfo, streams: StreamOptions): void {
    const api = this.#api;
    this.#registry = new FinalizationRegistry((state) => {
      if (!state.ptr || this.#finalized || this.#nativeFinalizing || this.#state === "closing") return;
      this.#proxies--;
      this.#releasedProxies.push(state.ptr);
      state.ptr = null;
      this.#scheduleDrain();
    });
    this.#handler = this.#proxyHandler();
    this.#trampoline = nativeSlot(
      api,
      (self, args, kw) =>
        this.#withGIL(() => {
          const result = this.#callJS(self as Pointer, args as Pointer, kw as Pointer);
          const error = api.PyErr_GetRaisedException();
          if (error) this.#trampoline.setNativeError(error);
          return result;
        }),
      c_void_p,
      [c_void_p, c_void_p, c_void_p],
    );

    this.#main = this.#import("__main__");
    this.#builtins = this.#import("builtins");
    this.#conversions = new PythonConversions(this.#builtins, (name) => this.#import(name));
    this.#buffers = new PythonBuffers(
      this.#builtins,
      (name) => this.#import(name),
      (message) => {
        api.PyErr_SetString(this.#pointer(this.#builtins.BufferError), message);
        throw this.#fetchError();
      },
    );
    this.#bootstrap = new PythonBootstrap(this.#builtins, (name) => this.#import(name));
    const adapters = this.#bootstrap.module;
    this.#mainThread = this.#bootstrap.mainThread;
    this.#jsProxyType = this.#pointer(this.#bootstrap.objectType);
    this.#functionType = this.#typeOf(this.#pointer(this.#bootstrap.wrap));
    this.#javascriptCode = this.#pointer(this.#bootstrap.javascriptCode);
    this.#scheduler = new PythonScheduler(
      this.#builtins,
      (name) => this.#import(name),
      adapters,
      addressof(Buffer.from(this.#busy.buffer)),
      (exception) => {
        api.PyErr_SetRaisedException(this.#toPy(exception));
        throw this.#fetchError();
      },
      this.#synchronousCallbacks,
    );
    this.#platform = new PythonPlatform(this.#builtins, (name) => this.#import(name), adapters);
    const javascript_object = (op: string, object: unknown, ...args: unknown[]) => this.#jsOp(op, object, ...args);
    adapters._op = javascript_object;
    this.#openChannel();

    // The environment of the probed interpreter (virtual environment included).
    const sys = this.#import("sys");
    sys.modules["_node_ctypes"] = adapters;
    let notify: bigint | undefined;
    if (this.#synchronousCallbacks) {
      const registration = adapters.register_native_dispatcher(() => this.#nativeObjects?.drain());
      notify = BigInt(registration[1]);
      registration[Symbol.dispose]();
    }
    this.#nativeObjects = this.#using(
      api.PyObject_GetAttrString(this.#pointer(adapters), "_op"),
      (operation) =>
        new NativeObjects(
          api,
          this.#check(this.#jsProxyType),
          {
            withGIL: <T>(fn: () => T) => this.#withGIL(fn),
            check: (ptr) => this.#check(ptr),
            fromPython: (ptr) => this.#fromPy(ptr, false, undefined, true),
            toPython: (value) => this.#toPy(value),
            operate: (op, self, args, kwargs) => {
              const values = args.map((arg) => this.#fromPy(arg, false, undefined, true));
              if (kwargs && api.PyDict_Size(kwargs) > 0) values.push(this.#fromPy(kwargs, true, undefined, true));
              return this.#jsOp(op, this.#fromPy(self, false), ...values);
            },
            raise: (error) => this.#raise(error),
          },
          {
            asyncIterator: this.#pointer(adapters._JsAsyncIterator),
            callLater: this.#pointer(adapters._call_later),
            operation: this.#check(operation),
            wrap: this.#pointer(this.#bootstrap.wrap),
          },
          notify,
        ),
    );
    this.#status(api.PyObject_SetAttrString(this.#pointer(adapters), "NativeJsProxy", this.#nativeObjects.type));
    sys.path = ["", ...info.path];
    sys.executable = info.executable;
    sys.argv = [process.argv[1] ?? ""];
    // Every Python call acquires the GIL on the Node.js thread: CPU-bound
    // Python threads can stall the event loop for several switch intervals.
    sys.setswitchinterval(this.#switchInterval / 1000);
    // Python reads stdin through a buffer: what it reads is lost for Node.js.
    if (!streams.stdin) sys.stdin = null;
    // Python writes to the file descriptors directly, Node.js through a queue
    // when they are pipes (macOS) or terminals (Windows): "node" keeps the order.
    for (const name of ["stdout", "stderr"] as const) {
      const target = streams[name];
      if (target === "inherit") continue;
      const write = target === "node" ? (text: string) => void process[name].write(text) : (text: string) => void target(text);
      this.#platform.redirect(name, write);
    }
  }

  // ── Public API ────────────────────────────────────────────────────

  /** The `__main__` module, where `exec` and `eval` run. */
  get main() {
    if (!this.#publicMain || !this.#states.get(this.#publicMain)?.ptr) this.#publicMain = this.#expose(this.#main) as PublicPythonObject;
    return this.#publicMain;
  }

  /** The `builtins` module (`len`, `sorted`, `dict`, ...). */
  get builtins() {
    if (!this.#publicBuiltins || !this.#states.get(this.#publicBuiltins)?.ptr) this.#publicBuiltins = this.#expose(this.#builtins) as PublicPythonObject;
    return this.#publicBuiltins;
  }

  /**
   * Execute Python statements in `__main__`.
   * @param {string} code
   */
  exec(code: string): Promise<void> {
    return this.#controlled((control) => this.#track(() => this.#executeSource(code, Py_file_input, false, false, control)).then(() => undefined));
  }

  /**
   * Evaluate a Python expression in `__main__` and convert the result to
   * JavaScript, deeply (lists, tuples, dicts and sets included).
   * @param {string} expression
   * @returns {*}
   */
  eval<T = unknown>(expression: string): Promise<T> {
    return this.#controlled((control) => this.#track(() => this.#executeSource(expression, Py_eval_input, true, false, control)).then(({ value }) => value as T));
  }

  /**
   * Import a module (Python: `import name`).
   * @param {string} name - Module name, e.g. "json" or "os.path"
   * @returns {*} Module proxy
   */
  import<T = PublicPythonObject>(name: string): Promise<T> {
    return this.#controlled((control) =>
      this.#track(async () => {
        const ptr = await this.#nativeCall("PyImport_ImportModule", [name], control);
        return this.#withGIL(() => ({ value: this.#take(ptr, true) }));
      }).then(({ value }) => value as T),
    );
  }

  /**
   * Create a module from JavaScript values and functions, importable by
   * Python code (`import name`). A dotted name is a submodule (`node.fs`:
   * `import node.fs`, `from node import fs`); missing parents are created as
   * empty packages.
   * @param {string} name - Module name
   * @param {Object} members - Module attributes
   * @returns {*} Module proxy
   */
  module(name: string, members: Record<string, unknown>): PublicPythonObject {
    return this.#withGIL(() => {
      const types = this.#import("types");
      const modules = this.#import("sys").modules;
      const module = types.ModuleType(name);
      for (const [key, value] of Object.entries(members)) module[key] = value;
      modules.__setitem__(name, module);
      // Link the module to its parent package, creating the missing ones.
      for (let child = module, childName = name; childName.includes(".");) {
        const dot = childName.lastIndexOf(".");
        const parentName = childName.slice(0, dot);
        let parent = modules.get(parentName);
        let created = false;
        if (parent === null) {
          try {
            parent = this.#import(parentName); // an existing package (json for json.extra)
          } catch (error) {
            const missing = error instanceof PythonError && error.type === "ModuleNotFoundError" ? error.exception.name : null;
            if (!(missing === parentName || parentName.startsWith(`${missing}.`))) throw error;
            parent = types.ModuleType(parentName);
            parent.__path__ = []; // a package
            modules.__setitem__(parentName, parent);
            created = true;
          }
        }
        this.#builtins.setattr(parent, childName.slice(dot + 1), child);
        if (!created) break;
        [child, childName] = [parent, parentName];
      }
      return this.#expose(module) as PublicPythonObject;
    });
  }

  /**
   * Convert a JavaScript value to a Python object, kept as a proxy (e.g. a
   * list modified by Python, or reused across calls without conversions).
   * @param {*} value
   * @returns {*} PyObject proxy
   */
  toPython<T = PublicPythonObject>(value: unknown): T {
    return this.#withGIL(() => this.#wrap(this.#toPy(value), true)) as T;
  }

  /**
   * Await a Python operation or awaitable (call, exec, eval, import,
   * coroutine, task, future) with an AbortSignal that cancels it:
   * `python.run(python.main.solve(puzzle), { signal:
   * AbortSignal.timeout(1000) })`. The promise rejects with `signal.reason`.
   * Synchronous Python code is interrupted once with KeyboardInterrupt
   * (native calls only when they return); asyncio work is cancelled.
   *
   * @param {*} awaitable - PyObject proxy or promise of a Python operation
   * @param {Object} [options]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<*>}
   */
  run<T = unknown>(awaitable: PublicPythonObject | PromiseLike<unknown>, { signal }: RunOptions = {}): Promise<T> {
    const owned = this.#states.has(awaitable);
    if (!owned && !isThenable(awaitable)) return Promise.reject(new TypeError("python.run() needs a Python awaitable or call promise"));
    const promise = (owned ? this.#promise(awaitable) : Promise.resolve(awaitable)) as Promise<T>;
    if (!signal) return promise;
    const control = this.#callControls.get(promise);
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        if (control) control.aborted = true;
        if (!this.#finalized && !this.#nativeFinalizing) {
          try {
            control?.cancel?.();
            const state = this.#states.get(owned ? awaitable : control?.awaitable);
            if (state?.ptr) this.#withGIL(() => state.future?.cancel());
          } catch {
            // Cancellation is best-effort: the promise still rejects with the reason.
          }
        }
        reject(signal.reason);
      };
      void promise.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  /**
   * Python's `with` statement: enter the context manager, run `body` with
   * the value of `__enter__()`, then exit it, passing the error thrown by
   * `body` to `__exit__()` (which may suppress it). If `body` returns a
   * promise, the context manager is exited when it settles.
   *
   * @example python.with(python.builtins.open(file), (f) => f.read())
   * @param {*} manager - Context manager (PyObject proxy)
   * @param {Function} body - Called with the value of `__enter__()`
   * @returns {*} What `body` returns (undefined if the error was suppressed)
   */
  async with<T, Entered = PublicPythonObject>(pending: PublicPythonObject | PromiseLike<PublicPythonObject>, body: (value: Entered) => T): Promise<Awaited<T> | undefined> {
    const manager = await pending;
    const [enter, exit] = this.#withGIL(() => {
      const type = this.#builtins.type(manager);
      return [type.__enter__, type.__exit__];
    });
    const value = await this.#callAsync(enter, [manager]);
    let result;
    try {
      result = await body(value as Entered);
    } catch (error) {
      if (await this.#exit(exit, manager, error)) return undefined;
      throw error;
    }
    await this.#callAsync(exit, [manager, null, null, null]);
    return result;
  }

  /**
   * Python's `async with` statement for asynchronous context managers
   * (`__aenter__` / `__aexit__`), awaited on the asyncio event loop.
   *
   * @param {*} manager - Asynchronous context manager (PyObject proxy)
   * @param {Function} body - Called with the value of `__aenter__()`; may be async
   * @returns {Promise<*>} What `body` returns (undefined if the error was suppressed)
   */
  async asyncWith<T, Entered = PublicPythonObject>(pending: PublicPythonObject | PromiseLike<PublicPythonObject>, body: (value: Entered) => T): Promise<Awaited<T> | undefined> {
    const manager = await pending;
    const [enter, exit] = this.#withGIL(() => {
      const type = this.#builtins.type(manager);
      return [type.__aenter__, type.__aexit__];
    });
    const value = await this.#callAsync(enter, [manager]);
    let result;
    try {
      result = await body(value as Entered);
    } catch (error) {
      if (await this.#exit(exit, manager, error)) return undefined;
      throw error;
    }
    await this.#callAsync(exit, [manager, null, null, null]);
    return result;
  }

  /** Call `__exit__` / `__aexit__` with the Python version of a JavaScript error. */
  async #exit(exit: PythonObject, manager: PublicPythonObject, error: unknown): Promise<boolean> {
    const args = this.#withGIL(() => {
      const exc = this.#wrap(this.#exception(error));
      return [manager, this.#builtins.type(exc), exc, exc.__traceback__];
    });
    const result = await this.#callAsync(exit, args);
    return this.#withGIL(() => this.#builtins.bool(result));
  }

  #controlled<T>(work: (control: CallControl) => Promise<T>): Promise<T> {
    const control: CallControl = { aborted: false };
    const promise = work(control);
    this.#callControls.set(promise, control);
    return promise;
  }

  /**
   * Objects shared by the two languages, to find leaks: PyObject proxies
   * alive in JavaScript, JavaScript functions and objects (JsProxy) used by
   * Python, pending awaits and JavaScript calls from Python threads.
   * @returns {{ proxies: number, functions: number, objects: number, awaits: number, calls: number }}
   */
  stats(): PythonStats {
    // Diagnostics stay readable while closing; only new Python work is refused then.
    const scheduler = this.#finalized || this.#nativeFinalizing ? undefined : this.#scheduler;
    const calls = scheduler ? this.#withGIL(() => scheduler.calls, true) : 0;
    return { proxies: this.#proxies, functions: this.#functions.size, objects: this.#objects.size, awaits: this.#awaits.size, calls };
  }

  /**
   * Drain accepted calls and close the Python executor, then finalize on
   * the host thread. Py_FinalizeEx and its atexit handlers are synchronous.
   * Also runs on normal beforeExit, but not during forced process.exit().
   */
  finalize(): Promise<void> {
    if (this.#finalized) return Promise.resolve();
    if (this.#depth > 0) return Promise.reject(new Error("Cannot finalize while executing Python or a Python callback; finalize after the call returns"));
    if (this.#closing) return this.#closing;
    this.#state = "closing";
    this.#closing = (async () => {
      await Promise.allSettled([...this.#pending]);
      for (const controller of this.#controllers.values()) controller.abort(new DOMException("Python has been finalized", "AbortError"));
      this.#controllers.clear();
      await this.#finish("finalized");
    })();
    return this.#closing;
  }

  async #finish(state: "finalized" | "failed"): Promise<void> {
    const errors: unknown[] = [];
    try {
      if (this.#scheduler) {
        try {
          const wait = this.#withGIL(() => this.#scheduler!.shutdown(), true);
          if (wait) {
            const args = this.#withGIL(() => this.#api.PyTuple_New(0), true);
            try {
              const result = await this.#nativeCall("PyObject_Call", [this.#pointer(wait), args, null]);
              this.#withGIL(() => this.#api.Py_DecRef(result), true);
            } finally {
              this.#withGIL(() => {
                this.#api.Py_DecRef(args);
                this.#release(wait);
              }, true);
            }
          }
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        this.#withGIL(() => {
          this.#drain();
          this.#nativeObjects?.releaseType();
        }, true);
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.#executor?.close();
        this.#nativeFinalizing = true;
        if (this.#threadState) this.#api.PyEval_RestoreThread(this.#threadState);
        this.#depth = 1;
        const status = this.#api.Py_FinalizeEx();
        if (typeof status !== "number" || status < 0) errors.push(new Error("Py_FinalizeEx failed while finalizing Python"));
      } catch (error) {
        errors.push(error);
      }
    } finally {
      this.#depth = 0;
      this.#threadState = null;
      this.#ownsInterpreter = false;
      this.#state = state;
      process.off("exit", this.#exitHandler);
      process.off("beforeExit", this.#beforeExitHandler);
      // Py_FinalizeEx invalidated every object, so no surviving proxy owns a reference.
      this.#proxies = 0;
      this.#functions.clear();
      this.#objects.clear();
      this.#objectIds = new WeakMap();
      this.#jsErrors.clear();
      this.#controllers.clear();
      this.#scheduler = undefined;
      try {
        this.#nativeObjects?.releaseCallbacks();
        this.#trampoline?.release();
      } catch (error) {
        errors.push(error);
      }
      this.#nativeObjects = undefined;
      for (const { reject } of this.#awaits.values()) reject(new Error("Python has been finalized"));
      this.#awaits.clear();
      const channel = this.#channel;
      this.#channel = null;
      try {
        channel?.release();
      } catch (error) {
        errors.push(error);
      }
      try {
        if (this.#releaseLibraryPath && !this.#api.Py_IsInitialized()) {
          this.#releaseLibraryPath();
          this.#releaseLibraryPath = undefined;
        }
      } catch (error) {
        errors.push(error);
      }
      try {
        releaseHost();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Python finalization failed");
  }

  // ── GIL ───────────────────────────────────────────────────────────

  #withGIL<T>(fn: () => T, closing = false): T {
    if (this.#finalized) throw new Error("Python has been finalized");
    if (this.#nativeFinalizing && this.#depth === 0) throw new Error("Python is finalizing");
    if (!closing && this.#state === "closing" && this.#depth === 0 && this.#pending.size === 0) throw new Error("Python is closing");
    if (this.#depth++ === 0) {
      this.#gilState = this.#api.PyGILState_Ensure();
      this.#busy[0] = 1;
    }
    try {
      return fn();
    } finally {
      if (--this.#depth === 0) {
        this.#busy[0] = 0;
        this.#api.PyGILState_Release(this.#gilState);
      }
    }
  }

  async #nativeCall(name: "PyImport_ImportModule" | "PyObject_Call" | "ExecuteSource", args: unknown[], control?: CallControl): Promise<Pointer> {
    const { request, task } = this.#withGIL(() => {
      const request = this.#filled(this.#api.PyTuple_New(args.length + 1), (tuple) => {
        this.#status(this.#api.PyTuple_SetItem(tuple, 0, this.#toPy(name)));
        args.forEach((value, i) => {
          const pointerArgument = name === "ExecuteSource" ? i === 2 : API[name][1][i] === c_void_p;
          const ptr = pointerArgument && value !== null ? this.#check(typeof value === "bigint" ? value : null) : this.#toPy(value);
          if (pointerArgument && value !== null) this.#api.Py_IncRef(ptr);
          this.#status(this.#api.PyTuple_SetItem(tuple, i + 1, ptr));
        });
      });
      try {
        const task = this.#executor.callAsync(request, control);
        if (control?.aborted) control.cancel?.();
        return { request, task };
      } catch (error) {
        this.#api.Py_DecRef(request);
        throw error;
      }
    }, true);
    try {
      const outcome = await task;
      return this.#withGIL(() => this.#consumeOutcome(outcome), true);
    } finally {
      this.#withGIL(() => this.#api.Py_DecRef(request), true);
    }
  }

  #consumeOutcome(outcome: Pointer): Pointer {
    return this.#using(this.#check(outcome), (outcome) => {
      if (this.#api.PyTuple_Size(outcome) !== 2n) throw new Error("Python executor returned an invalid outcome");
      const success = this.#status(this.#api.PyObject_IsTrue(this.#api.PyTuple_GetItem(outcome, 0)));
      const value = this.#check(this.#api.PyTuple_GetItem(outcome, 1));
      this.#api.Py_IncRef(value);
      if (success) return value;
      if (!this.#registry) {
        try {
          throw new Error(`Python startup failed: ${this.#take<string>(this.#api.PyObject_Str(value))}`);
        } finally {
          this.#api.Py_DecRef(value);
        }
      }
      this.#api.PyErr_SetRaisedException(value);
      throw this.#fetchError();
    });
  }
  #track<T>(work: () => Promise<T>): Promise<T> {
    if (this.#state !== "running") return Promise.reject(new Error(this.#finalized ? "Python has been finalized" : "Python is closing"));
    if (this.#depth > 0 && this.#asyncCallbackDepth !== this.#depth) return Promise.reject(new Error("Cannot start an asynchronous Python operation from a synchronous Python callback; await it from a Python coroutine instead"));
    let task: Promise<T>;
    try {
      task = this.#depth > 0 ? Promise.resolve().then(work) : work();
    } catch (error) {
      return Promise.reject(error);
    }
    this.#pending.add(task);
    void task.then(
      () => this.#pending.delete(task),
      () => this.#pending.delete(task),
    );
    return task;
  }

  async #executeSource(source: string, start: number, deep: boolean, initializing = false, control?: CallControl): Promise<{ value: unknown }> {
    const globals = this.#withGIL(() => this.#mainDict(), initializing);
    try {
      const result = await this.#nativeCall("ExecuteSource", [source, start, globals], control);
      return this.#withGIL(() => ({ value: deep ? this.#takeDeep(result, true) : this.#take(result, true) }), initializing);
    } finally {
      this.#withGIL(() => this.#drain(), initializing);
    }
  }

  #expose(value: unknown): unknown {
    const state = this.#states.get(value);
    if (!state || state.public) return value;
    return this.#withGIL(() => {
      this.#api.Py_IncRef(this.#pointer(value));
      return this.#wrap(state.ptr, true);
    });
  }

  // ── Conversions (GIL held) ────────────────────────────────────────

  #pointer(proxy: unknown): bigint {
    const state = this.#states.get(proxy);
    if (!state?.ptr) throw new Error("Python object has been released");
    return state.ptr;
  }

  #mainDict() {
    return this.#api.PyModule_GetDict(this.#pointer(this.#main));
  }

  #check(ptr: Pointer): bigint {
    if (!ptr) throw this.#fetchError();
    return ptr;
  }

  #run(source: string, start: number, globals: Pointer): bigint {
    const api = this.#api;
    return this.#using(this.#check(api.Py_CompileString(source, "<string>", start)), (code) => this.#check(api.PyEval_EvalCode(code, globals, globals)));
  }

  #import(name: string): PythonObject {
    return this.#take(this.#api.PyImport_ImportModule(name));
  }

  #typeOf(ptr: Pointer): Pointer {
    const type = this.#api.PyObject_Type(ptr);
    this.#api.Py_DecRef(type); // type objects outlive their instances
    return type;
  }

  /** Call a Python callable with new references as arguments (stolen); returns a new reference. */
  #callRaw(callable: PythonObject, args: Pointer[]): bigint {
    const api = this.#api;
    const tuple = this.#filled(api.PyTuple_New(args.length), (t) => args.forEach((arg, i) => api.PyTuple_SetItem(t, i, arg)));
    return this.#using(tuple, (t) => this.#check(api.PyObject_Call(this.#pointer(callable), t, null)));
  }

  /** Use a new reference, then release it. */
  #usingProxy<T>(ptr: Pointer, use: (object: PythonObject) => T): T {
    this.#api.Py_IncRef(ptr);
    const object = this.#wrap(this.#check(ptr));
    try {
      return use(object);
    } finally {
      this.#release(object);
    }
  }

  #takeProxy(object: PythonObject): bigint {
    const ptr = this.#check(this.#pointer(object));
    this.#api.Py_IncRef(ptr);
    this.#release(object);
    return ptr;
  }

  #using<T>(ptr: Pointer, use: (ptr: Pointer) => T): T {
    try {
      return use(ptr);
    } finally {
      this.#api.Py_DecRef(ptr);
    }
  }

  /** New reference → JavaScript (shallow). */
  #take<T = PythonObject>(ptr: Pointer, external = false): T {
    return this.#using(this.#check(ptr), (p) => this.#fromPy(p, false, undefined, external)) as T;
  }

  /** New reference → JavaScript (deep). */
  #takeDeep<T = unknown>(ptr: Pointer, external = false): T {
    return this.#using(this.#check(ptr), (p) => this.#fromPy(p, true, undefined, external)) as T;
  }

  /** Borrowed reference → JavaScript value or PyObject proxy. */
  #fromPy(ptr: Pointer, deep: boolean, ancestors?: Set<bigint>, external = false): unknown {
    const api = this.#api;
    const T = this.#types;
    if (ptr === this.#none) return null;
    const type = this.#typeOf(ptr);
    switch (type) {
      case T.PyBool_Type:
        return ptr === this.#true;
      case T.PyLong_Type: {
        const overflow = new c_int();
        const value = api.PyLong_AsLongLongAndOverflow(ptr, byref(overflow));
        if (overflow.value) return BigInt(this.#take<string>(api.PyObject_Str(ptr)));
        return value >= -9007199254740991n && value <= 9007199254740991n ? Number(value) : value;
      }
      case T.PyFloat_Type:
        return api.PyFloat_AsDouble(ptr);
      case T.PyUnicode_Type: {
        const size = new c_ssize_t();
        const data = this.#check(api.PyUnicode_AsUTF8AndSize(ptr, byref(size)));
        const utf8 = Buffer.alloc(Number(size.value));
        if (utf8.length) memmove(utf8, data, utf8.length);
        return utf8.toString("utf8");
      }
      case T.PyBytes_Type: {
        const data = new c_void_p();
        const size = new c_ssize_t();
        if (api.PyBytes_AsStringAndSize(ptr, byref(data), byref(size)) < 0) throw this.#fetchError();
        const bytes = Buffer.alloc(Number(size.value));
        if (bytes.length) memmove(bytes, data.value, bytes.length);
        return bytes;
      }
    }
    if (type === this.#jsProxyType || (this.#nativeObjects !== undefined && type === this.#nativeObjects.type)) {
      const id = this.#take<number | bigint>(api.PyObject_GetAttrString(ptr, "_id"));
      return this.#objects.get(BigInt(id))?.value;
    }
    if (type === this.#functionType && this.#using(this.#check(api.PyObject_GetAttrString(ptr, "__code__")), (code) => code === this.#javascriptCode)) {
      const fn = this.#functions.get(BigInt(this.#take<number | bigint>(api.PyObject_GetAttrString(ptr, "_node_ctypes_id"))))?.fn;
      if (fn) return fn; // a JavaScript function back in JavaScript
    }
    if (deep) {
      if (ptr !== null && (type === T.PyList_Type || type === T.PyTuple_Type || type === T.PyDict_Type || type === T.PySet_Type || type === T.PyFrozenSet_Type)) {
        ancestors ??= new Set();
        if (ancestors.has(ptr)) throw new TypeError("Cannot deeply convert a circular Python container; use its live Python proxy instead");
        ancestors.add(ptr);
        try {
          switch (type) {
            case T.PyList_Type:
            case T.PyTuple_Type: {
              const list = type === T.PyList_Type;
              const size = Number(list ? api.PyList_Size(ptr) : api.PyTuple_Size(ptr));
              const items = list ? new Array(size) : new Tuple(size);
              for (let i = 0; i < size; i++) items[i] = this.#fromPy(list ? api.PyList_GetItem(ptr, i) : api.PyTuple_GetItem(ptr, i), true, ancestors, external);
              return items;
            }
            case T.PyDict_Type: {
              const entries: [unknown, unknown][] = [];
              const pos = new c_ssize_t();
              const key = new c_void_p();
              const value = new c_void_p();
              while (api.PyDict_Next(ptr, byref(pos), byref(key), byref(value))) {
                entries.push([this.#fromPy(key.value, true, ancestors, external), this.#fromPy(value.value, true, ancestors, external)]);
              }
              return entries.every(([k]) => typeof k === "string") ? Object.fromEntries(entries) : new Map(entries);
            }
            case T.PySet_Type:
            case T.PyFrozenSet_Type:
              return new Set(this.#items(ptr, ancestors, external));
          }
        } finally {
          ancestors.delete(ptr);
        }
      }
      const special = this.#usingProxy(ptr, (object) => this.#conversions.toJSValue(object, Boolean(Temporal)));
      if (special !== null) {
        const [kind, ...f] = special;
        switch (kind) {
          case "Date":
            return new Date(f[0]);
          case "PlainDate":
            return new Temporal!.PlainDate(f[0], f[1], f[2]);
          case "PlainTime":
            return new Temporal!.PlainTime(f[0], f[1], f[2], Math.floor(f[3] / 1000), f[3] % 1000);
          case "Duration":
            return new Temporal!.Duration(0, 0, 0, ...f);
        }
      }
    }
    api.Py_IncRef(ptr);
    return this.#wrap(ptr, external);
  }

  /** Items of an iterable, deeply converted. */
  #items(ptr: Pointer, ancestors?: Set<bigint>, external = false): unknown[] {
    const api = this.#api;
    return this.#using(this.#check(api.PyObject_GetIter(ptr)), (iterator) => {
      const items: unknown[] = [];
      for (let item = api.PyIter_Next(iterator); item; item = api.PyIter_Next(iterator)) {
        items.push(this.#using(item, (p) => this.#fromPy(p, true, ancestors, external)));
      }
      if (api.PyErr_Occurred()) throw this.#fetchError();
      return items;
    });
  }

  /** JavaScript value → new reference. */
  #toPy(value: unknown, ancestors?: Set<object>): bigint {
    const api = this.#api;
    if (value === null || value === undefined) {
      api.Py_IncRef(this.#none);
      return this.#none;
    }
    if (this.#states.has(value)) {
      const ptr = this.#pointer(value);
      api.Py_IncRef(ptr);
      return ptr;
    }
    switch (typeof value) {
      case "boolean":
        return this.#check(api.PyBool_FromLong(value ? 1 : 0));
      case "number":
        if (!Number.isInteger(value)) return this.#check(api.PyFloat_FromDouble(value));
        return this.#check(Number.isSafeInteger(value) ? api.PyLong_FromLongLong(value) : api.PyLong_FromDouble(value));
      case "bigint":
        return this.#check(api.PyLong_FromString(value.toString(), null, 10));
      case "string": {
        const utf8 = Buffer.from(value, "utf8");
        return this.#check(api.PyUnicode_DecodeUTF8(utf8, utf8.length, null));
      }
      case "function":
        return this.#function(value);
    }
    if (value instanceof Kwargs) throw new TypeError("kwargs() must be the last argument of a call");
    if (value instanceof ByReference) return this.#reference(value.value);
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) throw new TypeError("Cannot convert an Invalid Date to a Python object");
      return this.#takeProxy(this.#conversions.fromTimestamp(value.getTime()));
    }
    if (Temporal) {
      const fields = temporalFields(value);
      if (fields) return this.#takeProxy(this.#conversions.fromTemporal(fields));
    }
    if (value instanceof Uint8Array && !(value instanceof Uint8ClampedArray)) return this.#check(api.PyBytes_FromStringAndSize(Buffer.from(value.buffer, value.byteOffset, value.byteLength), value.byteLength));
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) return this.#memoryview(value);
    if (typeof value !== "object") throw new TypeError(`Cannot convert a JavaScript ${typeof value} to Python`);
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && !(value instanceof Set) && !(value instanceof Map) && proto !== Object.prototype && proto !== null) return this.#jsProxy(value);
    ancestors ??= new Set();
    if (ancestors.has(value)) throw new TypeError("Cannot copy a circular JavaScript container to Python; use byReference() instead");
    ancestors.add(value);
    try {
      if (value instanceof Tuple) {
        return this.#filled(api.PyTuple_New(value.length), (tuple) => {
          for (let i = 0; i < value.length; i++) api.PyTuple_SetItem(tuple, i, this.#toPy(value[i], ancestors)); // steals the item
        });
      }
      if (Array.isArray(value)) {
        return this.#filled(api.PyList_New(value.length), (list) => {
          for (let i = 0; i < value.length; i++) api.PyList_SetItem(list, i, this.#toPy(value[i], ancestors)); // steals the item
        });
      }
      if (value instanceof Set) {
        return this.#filled(api.PySet_New(null), (set) => {
          for (const item of value) this.#status(this.#using(this.#toPy(item, ancestors), (p) => api.PySet_Add(set, p)));
        });
      }
      return this.#filled(api.PyDict_New(), (dict) => {
        for (const [k, v] of value instanceof Map ? value.entries() : Object.entries(value as object)) {
          this.#status(this.#using(this.#toPy(k, ancestors), (key) => this.#using(this.#toPy(v, ancestors), (item) => api.PyDict_SetItem(dict, key, item))));
        }
      });
    } finally {
      ancestors.delete(value);
    }
  }

  /** byReference(value) → new reference. */
  #reference(value: unknown): bigint {
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) return this.#memoryview(value);
    if (value === null || typeof value !== "object" || this.#states.has(value)) return this.#toPy(value);
    return this.#jsProxy(value);
  }

  /** JsProxy of a JavaScript object (new reference). */
  #jsProxy(value: object): bigint {
    const native = this.#nativeObjects;
    if (!native) throw new Error("Native Python objects are not initialized");
    let id = this.#objectIds.get(value);
    if (id === undefined) {
      id = this.#nextId++;
      this.#objectIds.set(value, id);
      this.#objects.set(id, { value, count: 0 });
    }
    const entry = this.#objects.get(id)!;
    entry.count++; // one per JsProxy instance: decremented by its weakref.finalize
    try {
      return this.#using(this.#toPy(id), (id) => native.create(this.#check(id)));
    } catch (error) {
      this.#forgetObject(id);
      throw error;
    }
  }

  #forgetObject(id: bigint): void {
    const entry = this.#objects.get(id);
    if (!entry || --entry.count > 0) return;
    this.#objects.delete(id);
    this.#objectIds.delete(entry.value);
  }

  /** memoryview sharing the memory of a typed array / ArrayBuffer / DataView (new reference). */
  #memoryview(value: ArrayBufferLike | ArrayBufferView): bigint {
    const view = value instanceof ArrayBuffer || value instanceof SharedArrayBuffer ? new Uint8Array(value) : value;
    const bytes = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    const format = FORMATS[view.constructor.name] ?? "B"; // DataView: bytes
    const address = bytes.length ? addressof(bytes) : 0n;
    return this.#using(this.#jsProxy(view.buffer), (keep) => this.#usingProxy(keep, (keep) => this.#takeProxy(this.#buffers.memory(address, bytes.length, format, keep))));
  }

  /** Typed array sharing the memory of a Python buffer (copied if read-only). */
  #typedArray(target: PythonObject): PythonTypedArray {
    return this.#withGIL(() => {
      const [name, holder, address, size, copy] = this.#buffers.export(target);
      const Type = (Reflect.get(globalThis, name) as TypedArrayConstructor | undefined) ?? Uint8Array;
      if (copy) return new Type(copy.buffer, copy.byteOffset, copy.length / Type.BYTES_PER_ELEMENT);
      if (!size) return new Type(0);
      if (!EXTERNAL_BUFFERS) {
        // Electron forbids buffers over external memory: a copy.
        const copied = new Type(size / Type.BYTES_PER_ELEMENT);
        memmove(Buffer.from(copied.buffer), address, size);
        return copied;
      }
      const memory = array(c_uint8, size).from_address(address)._buffer; // Python: memoryview((c_ubyte * size).from_address(address))
      this.#keep.set(memory.buffer, holder); // pins the Python buffer while the memory is used
      return new Type(memory.buffer, memory.byteOffset, size / Type.BYTES_PER_ELEMENT);
    });
  }

  // ── JavaScript objects used by Python (JsProxy) ───────────────────

  /** An operation of a shared object, on the Node.js main thread. */
  #jsOp(op: string, object: unknown, ...args: unknown[]): unknown {
    // Objects reached through a JsProxy are used by reference too.
    const ref = (value: unknown) => (value !== null && typeof value === "object" && !this.#states.has(value) && !(value instanceof Date) ? new ByReference(value) : value);
    const key = (value: unknown): PropertyKey => (typeof value === "symbol" ? value : String(value));
    const get = (name: PropertyKey): unknown => Reflect.get(Object(object), name);
    const has = (name: unknown): boolean => key(name) in Object(object);
    const set = (name: unknown, value: unknown): void => {
      if (!Reflect.set(Object(object), key(name), value)) throw new TypeError(`Cannot assign to JavaScript property ${String(name)}`);
    };
    const remove = (name: unknown): void => {
      if (!Reflect.deleteProperty(Object(object), key(name))) throw new TypeError(`Cannot delete JavaScript property ${String(name)}`);
    };
    const invoke = (name: PropertyKey, ...values: unknown[]): unknown => {
      const fn = get(name);
      if (typeof fn !== "function") throw new TypeError(`${String(name)} is not a function`);
      return Reflect.apply(fn, object, values);
    };
    const isMap = object instanceof Map;
    const isSequence = Array.isArray(object) || (ArrayBuffer.isView(object) && !(object instanceof DataView));
    const index = (key: unknown, insert = false): number => {
      const length = Number(get("length"));
      const i = typeof key === "number" && Number.isInteger(key) ? (key < 0 ? key + length : key) : NaN;
      if (!(i >= 0 && (i < length || (insert && i === length)))) throw pythonError("IndexError", `${typeName(object)} index out of range`);
      return i;
    };
    const missing = (key: unknown) => pythonError("KeyError", typeof key === "string" ? `'${key}'` : String(key));
    const size = (): number => {
      const length = get("length");
      if (isSequence || typeof length === "number") return Number(length);
      const size = get("size");
      if (typeof size === "number") return size;
      throw pythonError("TypeError", `object of type '${typeName(object)}' has no len()`);
    };
    const [name, value] = args;
    switch (op) {
      case "getattr": {
        if (!has(name)) throw pythonError("AttributeError", `'${typeName(object)}' JavaScript object has no attribute '${String(name)}'`);
        const member = get(key(name));
        if (typeof member !== "function" || this.#states.has(member) || isClass(member)) return ref(member); // Python callables stay themselves
        const method = member.bind(object);
        if (Reflect.get(member, CANCELLABLE)) Object.assign(method, { [CANCELLABLE]: true });
        return method;
      }
      case "setattr":
        set(name, value);
        return null;
      case "delattr":
        if (!has(name)) throw pythonError("AttributeError", String(name));
        remove(name);
        return null;
      case "getitem":
        if (isMap) {
          if (!object.has(name)) throw missing(name);
          return ref(object.get(name));
        }
        if (isSequence) return ref(get(String(index(name))));
        if (!has(name)) throw missing(name);
        return ref(get(key(name)));
      case "setitem":
        if (isMap) object.set(name, value);
        else if (isSequence) set(index(name, Array.isArray(object)), value);
        else set(name, value);
        return null;
      case "delitem":
        if (isMap) {
          if (!object.delete(name)) throw missing(name);
        } else if (Array.isArray(object)) object.splice(index(name), 1);
        else {
          if (!has(name)) throw missing(name);
          remove(name);
        }
        return null;
      case "contains":
        if (isMap || object instanceof Set) return object.has(name);
        if (object instanceof WeakSet) return object.has(name as object);
        if (isSequence) return invoke("includes", name);
        return typeof name === "string" && has(name);
      case "len":
        return size();
      case "bool":
        return isSequence || isMap || object instanceof Set ? size() > 0 : true;
      case "iter": {
        if (isMap) return ref(object.keys()); // like a dict
        if (typeof get(Symbol.iterator) === "function") return ref(invoke(Symbol.iterator));
        if (Object.getPrototypeOf(object) === Object.prototype || Object.getPrototypeOf(object) === null) return ref(Object.keys(Object(object))[Symbol.iterator]());
        throw pythonError("TypeError", `'${typeName(object)}' JavaScript object is not iterable`);
      }
      case "next": {
        const step = invoke("next") as IteratorResult<unknown>;
        return Tuple.of(Boolean(step.done), ref(step.value));
      }
      case "aiter": {
        const iterator = (get(Symbol.asyncIterator) == null ? undefined : invoke(Symbol.asyncIterator)) ?? (get(Symbol.iterator) == null ? undefined : invoke(Symbol.iterator));
        if (!iterator) throw pythonError("TypeError", `'${typeName(object)}' JavaScript object is not async iterable`);
        return ref(iterator);
      }
      case "anext":
        return Promise.resolve(invoke("next") as IteratorResult<unknown> | PromiseLike<IteratorResult<unknown>>).then((step) => Tuple.of(Boolean(step.done), ref(step.value)));
      case "serve": // a pending call: the main thread serves a call from a Python thread
        this.#serve(object as number);
        return null;
      case "await":
        return object; // a promise: the call settles when it does
      case "new":
        if (typeof object !== "function") throw new TypeError("JavaScript value is not a constructor");
        return ref(Reflect.construct(object, args));
      case "dir": {
        const names = new Set<string>();
        for (let o = object; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
          for (const key of Object.getOwnPropertyNames(o)) if (key !== "constructor") names.add(key);
        }
        return [...names].sort();
      }
      case "repr":
        return inspect(object, { depth: 2, breakLength: Infinity });
      case "str":
        return String(object);
    }
    throw new Error(`Unknown JsProxy operation ${op}`);
  }

  /** Fill a new container, releasing it if filling fails. */
  #filled(ptr: Pointer, fill: (ptr: bigint) => void): bigint {
    const checked = this.#check(ptr);
    try {
      fill(checked);
      return checked;
    } catch (error) {
      this.#api.Py_DecRef(ptr);
      throw error;
    }
  }

  /** Check the int status of a C API call (-1 = exception). */
  #status(result: number): number {
    if (result < 0) throw this.#fetchError();
    return result;
  }

  // ── PyObject proxies ──────────────────────────────────────────────

  /** Proxy owning a new reference. */
  #wrap(ptr: Pointer, external: true): PublicPythonObject;
  #wrap(ptr: Pointer, external?: false): PythonObject;
  #wrap(ptr: Pointer, external: boolean): PythonObject | PublicPythonObject;
  #wrap(ptr: Pointer, external = false): PythonObject | PublicPythonObject {
    const state: ProxyState = { ptr, public: external };
    const target = function () {}.bind(null) as unknown as PythonObject; // callable, constructible, without own non-configurable properties
    // util.inspect formats the target of a proxy: show repr(obj).
    Object.defineProperty(target, inspect.custom, {
      value: () => (state.ptr && !this.#finalized ? this.#withGIL(() => this.#take(this.#api.PyObject_Repr(state.ptr))) : "<released Python object>"),
      configurable: true,
      enumerable: true,
      writable: true,
    });
    const proxy = new Proxy(target, this.#handler);
    this.#states.set(target, state);
    this.#states.set(proxy, state);
    this.#registry.register(proxy, state, state);
    this.#proxies++;
    return proxy;
  }

  #proxyHandler(): ProxyHandler<PythonObject> {
    const api = this.#api;
    const live = (target: PythonObject): bigint => {
      const state = this.#states.get(target)!;
      if (!state.ptr) throw new Error("Python object has been released");
      return state.ptr;
    };
    const str = (target: PythonObject) => this.#withGIL(() => this.#take<string>(api.PyObject_Str(live(target))));
    const index = <T>(prop: string, use: (ptr: Pointer) => T) => this.#using(this.#toPy(Number(prop)), use);
    // After a failed attribute operation: continue only on AttributeError.
    const missingAttribute = () => {
      if (!api.PyErr_ExceptionMatches(this.#attributeError)) throw this.#fetchError();
      api.PyErr_Clear();
    };
    return {
      get: (target, prop) => {
        if (typeof prop === "symbol") {
          if (prop === inspect.custom) return Reflect.get(target, inspect.custom);
          if (prop === Symbol.iterator) return () => this.#iterate(target);
          if (prop === Symbol.asyncIterator) return this.#states.get(target)!.ptr && this.#withGIL(() => this.#scheduler!.isAsyncIterable(target)) ? () => this.#aiterate(target) : undefined;
          if (prop === Symbol.dispose) return () => this.#release(target);
          if (prop === Symbol.toPrimitive) return (hint: string) => this.#withGIL(() => this.#usingProxy(live(target), (object) => this.#conversions.toPrimitive(object, hint)));
          return undefined;
        }
        switch (prop) {
          case "then": {
            // Awaitables (coroutines, tasks, futures) are thenables: `await obj`.
            const state = this.#states.get(target)!;
            if (!state.ptr || this.#finalized || this.#nativeFinalizing || (this.#state === "closing" && this.#pending.size === 0) || !this.#withGIL(() => this.#scheduler!.isAwaitable(target))) return undefined;
            return (onFulfilled: ((value: unknown) => unknown) | undefined, onRejected: ((reason: unknown) => unknown) | undefined) => this.#promise(target).then(onFulfilled, onRejected);
          }
          case "toString":
            return () => str(target);
          case "toTypedArray":
            return () => this.#typedArray(target);
          case "toJS":
          case "toJSON": // JSON.stringify()
            return () => this.#withGIL(() => this.#fromPy(live(target), true, undefined, this.#states.get(target)!.public));
        }
        return this.#withGIL(() => {
          const ptr = live(target);
          if (isIndex(prop)) return index(prop, (key) => this.#take(api.PyObject_GetItem(ptr, key), this.#states.get(target)!.public));
          const value = api.PyObject_GetAttrString(ptr, prop);
          if (value) return this.#take(value, this.#states.get(target)!.public);
          missingAttribute();
          try {
            const value = this.#conversions.getFallback(target, prop);
            return this.#states.get(target)!.public ? this.#expose(value) : value;
          } catch (error) {
            // Function.prototype members of callables (see FUNCTION_MEMBERS).
            if (FUNCTION_MEMBERS.has(prop) && error instanceof PythonError && error.type === "AttributeError") return Reflect.get(target, prop);
            throw error;
          }
        });
      },
      set: (target, prop, value) => {
        if (typeof prop === "symbol") return false;
        this.#withGIL(() => {
          const ptr = live(target);
          this.#using(this.#toPy(value), (item) => {
            if (isIndex(prop)) return this.#status(index(prop, (key) => api.PyObject_SetItem(ptr, key, item)));
            if (api.PyObject_SetAttrString(ptr, prop, item) === 0) return;
            missingAttribute();
            this.#usingProxy(item, (value) => this.#conversions.setFallback(target, prop, value));
          });
        });
        return true;
      },
      has: (target, prop) => typeof prop === "string" && this.#withGIL(() => api.PyObject_HasAttrString(live(target), prop) === 1 || this.#conversions.isKey(target, prop)),
      deleteProperty: (target, prop) => {
        this.#withGIL(() => {
          if (api.PyObject_SetAttrString(live(target), String(prop), null) === 0) return;
          missingAttribute();
          this.#conversions.deleteFallback(target, String(prop)); // mapping key
        });
        return true;
      },
      // Object.keys(), Object.entries(), { ...dict }, for...in: the string keys of mappings.
      ownKeys: (target) => this.#withGIL(() => this.#conversions.keys(target)),
      getOwnPropertyDescriptor: (target, prop) => {
        if (typeof prop === "string" && this.#withGIL(() => this.#conversions.isKey(target, prop))) {
          return {
            value: this.#withGIL(() => {
              const value = this.#conversions.item(target, prop);
              return this.#states.get(target)!.public ? this.#expose(value) : value;
            }),
            writable: true,
            enumerable: true,
            configurable: true,
          };
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
      apply: (target, _this, args) => (this.#states.get(target)!.public ? this.#callAsync(target, args) : this.#withGIL(() => this.#call(live(target), args))),
      construct: (target, args) => (this.#states.get(target)!.public ? this.#callAsync(target, args, true) : (this.#withGIL(() => this.#call(live(target), args, true)) as PythonObject)),
    };
  }

  #callAsync(target: PythonObject, args: unknown[], keep = false): Promise<unknown> {
    const control: CallControl = { aborted: false };
    const promise = this.#track(async () => {
      const held = this.#withGIL(() => {
        const callable = this.#toPy(target);
        const values = args.at(-1) instanceof Kwargs ? args.slice(0, -1) : args;
        const pointers: Pointer[] = [callable];
        try {
          const tuple = this.#filled(this.#api.PyTuple_New(values.length), (tuple) => values.forEach((value, i) => this.#status(this.#api.PyTuple_SetItem(tuple, i, this.#toPy(value)))));
          pointers.push(tuple);
          const last = args.at(-1);
          const keywords = last instanceof Kwargs ? this.#toPy(last.values) : null;
          pointers.push(keywords);
          return pointers;
        } catch (error) {
          for (const ptr of pointers) this.#api.Py_DecRef(ptr);
          throw error;
        }
      });
      try {
        const result = await this.#nativeCall("PyObject_Call", held, control);
        return this.#withGIL(() => {
          let value: unknown = keep ? this.#wrap(this.#check(result), true) : this.#take(result, true);
          if (this.#states.has(value) && this.#scheduler!.isAwaitable(value as PythonObject)) {
            const awaitable = value as PythonObject;
            control.awaitable = awaitable;
            value = this.#promise(awaitable);
            if (control.aborted) this.#states.get(awaitable)!.future?.cancel();
          }
          return { value };
        });
      } finally {
        this.#withGIL(() => {
          for (const ptr of held) this.#api.Py_DecRef(ptr);
          this.#drain();
        });
      }
    }).then(({ value }) => value);
    this.#callControls.set(promise, control);
    return promise;
  }

  /** Call a Python callable; `keep`: the result stays a proxy (`new`, which must return an object). */
  #call(callable: Pointer, args: unknown[], keep = false): unknown {
    const api = this.#api;
    const take = keep ? (ptr: Pointer) => this.#wrap(this.#check(ptr)) : (ptr: Pointer) => this.#take(ptr);
    let keywords: Record<string, unknown> | null = null;
    const last = args[args.length - 1];
    if (last instanceof Kwargs) {
      keywords = last.values;
      args = args.slice(0, -1);
    }
    // Tuple items are stolen references.
    const tuple = this.#filled(api.PyTuple_New(args.length), (t) => args.forEach((arg, i) => api.PyTuple_SetItem(t, i, this.#toPy(arg))));
    return this.#using(tuple, () => {
      if (!keywords) return take(api.PyObject_Call(callable, tuple, null));
      return this.#using(this.#toPy(keywords), (dict) => take(api.PyObject_Call(callable, tuple, dict)));
    });
  }

  *#iterate(target: PythonObject): Generator<unknown> {
    const api = this.#api;
    const iterator = this.#withGIL(() => {
      const state = this.#states.get(target)!;
      if (!state.ptr) throw new Error("Python object has been released");
      return this.#check(api.PyObject_GetIter(state.ptr));
    });
    try {
      while (true) {
        const item = this.#withGIL(() => {
          const next = api.PyIter_Next(iterator);
          if (next) return this.#take(next, this.#states.get(target)!.public);
          if (api.PyErr_Occurred()) throw this.#fetchError();
          return DONE;
        });
        if (item === DONE) return;
        yield item;
      }
    } finally {
      if (!this.#finalized) this.#withGIL(() => api.Py_DecRef(iterator));
    }
  }

  /** for await over a Python async iterator (async generators, ...). */
  async *#aiterate(target: PythonObject): AsyncGenerator<unknown> {
    const iterator = this.#withGIL(() => this.#scheduler!.asyncIterator(target));
    let finished = false;
    try {
      while (true) {
        const [done, value] = await this.#scheduler!.next(iterator);
        if (done) {
          finished = true;
          return;
        }
        yield this.#withGIL(() => this.#expose(value));
      }
    } finally {
      // break / return / throw in the loop: close the async generator.
      if (!finished && !this.#finalized) {
        const close = this.#scheduler!.closeIterator(iterator);
        if (close !== null) await close;
      }
    }
  }

  #release(target: PythonObject): void {
    const state = this.#states.get(target)!;
    if (!state.ptr || this.#finalized || this.#nativeFinalizing) return;
    const ptr = state.ptr;
    state.ptr = null;
    this.#registry.unregister(state);
    this.#proxies--;
    // Outcome handlers may dispose the final exception after pending calls drain.
    this.#withGIL(() => this.#api.Py_DecRef(ptr), true);
  }

  // ── asyncio ───────────────────────────────────────────────────────

  /** Promise of an awaitable, run once on the Python event loop. */
  #promise(target: unknown): Promise<unknown> {
    const state = this.#states.get(target)!;
    state.promise ??= new Promise((resolve, reject) => {
      const token = this.#nextToken++;
      this.#withGIL(() => {
        this.#awaits.set(token, { resolve, reject, future: null });
        this.#channel!.ref(); // Node.js waits for Python
        try {
          state.future = this.#awaits.get(token)!.future = this.#usingProxy(this.#pointer(target), (awaitable) => {
            const future = this.#scheduler!.submit(awaitable, token);
            return future === awaitable ? this.#wrap(this.#toPy(future)) : future;
          });
        } catch (error) {
          this.#awaits.delete(token);
          this.#unrefChannel();
          throw error;
        }
      });
    });
    return state.promise;
  }

  /**
   * The channel from Python threads to Node.js. Unreferenced, like an
   * unref()'d timer: Python activity alone does not keep Node.js alive, only
   * JavaScript awaiting Python code does.
   */
  #openChannel() {
    this.#channel = threadSafeCallback((kind, token) => this.#onEvent(kind, token), null, [c_int, c_int]).unref();
    this.#scheduler!.openChannel(this.#channel.pointer);
  }

  #unrefChannel() {
    if (this.#awaits.size === 0 && this.#channel && !this.#finalized) this.#channel.unref();
  }

  /** Channel event, on the Node.js main thread. */
  #onEvent(kind: number, token: number): void {
    if (this.#finalized || (this.#state === "closing" && this.#pending.size === 0)) return;
    switch (kind) {
      case EVENT_DONE: {
        const entry = this.#awaits.get(token);
        if (!entry) break;
        this.#awaits.delete(token);
        this.#withGIL(() => {
          try {
            entry.resolve(entry.future!.result());
          } catch (error) {
            entry.reject(error);
          }
        });
        this.#unrefChannel();
        break;
      }
      case EVENT_CALL:
        this.#serve(token);
        break;
      case EVENT_CANCEL:
        this.#controllers.get(token)?.abort(new DOMException("The call was cancelled by Python", "AbortError"));
        this.#controllers.delete(token);
        break;
    }
  }

  /** Run a JavaScript function called by a coroutine and settle its asyncio future. */
  #serve(token: number): void {
    const settle = (ok: boolean, value: unknown): void => {
      this.#controllers.delete(token);
      if (this.#finalized || (this.#state === "closing" && this.#pending.size === 0)) return;
      this.#withGIL(() => {
        try {
          this.#using(ok ? this.#toPy(value) : this.#exception(value), (pointer) => this.#usingProxy(pointer, (value) => this.#scheduler!.settle(token, ok, value)));
        } catch (error) {
          if (ok) return settle(false, error); // e.g. a value without a Python equivalent
          throw error;
        }
      });
    };
    let result: unknown;
    try {
      const call = this.#withGIL((): [FunctionEntry, unknown[]] | null => {
        const request = this.#scheduler!.takeRequest(token);
        if (request === null) return null; // cancelled meanwhile
        try {
          const fid: unknown = request[0];
          if (typeof fid !== "bigint" && (typeof fid !== "number" || !Number.isSafeInteger(fid))) throw new TypeError("Invalid JavaScript function identifier");
          const args: PythonObject = request[1];
          const kw: PythonObject = request[2];
          const entry = this.#functions.get(BigInt(fid));
          if (!entry) throw new Error("JavaScript function has been released");
          const jsArgs: unknown[] = [...args].map((value) => this.#expose(value));
          if (this.#builtins.len(kw) > 0) jsArgs.push(this.#fromPy(this.#pointer(kw), true, undefined, true));
          return [entry, jsArgs];
        } finally {
          request[Symbol.dispose]();
        }
      });
      if (call === null) return;
      const [entry, args] = call;
      if (entry.fn[CANCELLABLE]) {
        const controller = new AbortController();
        this.#controllers.set(token, controller);
        args.push(controller.signal);
      }
      const previousDepth = this.#asyncCallbackDepth;
      this.#asyncCallbackDepth = this.#depth;
      try {
        result = entry.isClass ? Reflect.construct(entry.fn, args) : entry.fn(...args);
      } finally {
        this.#asyncCallbackDepth = previousDepth;
      }
    } catch (error) {
      return settle(false, error);
    }
    // Synchronous results settle now: the call may be served from inside
    // Python (a pending call), where promise reactions cannot run.
    if (!isThenable(result) || this.#states.has(result)) return settle(true, result);
    Promise.resolve(result).then(
      (value) => settle(true, value),
      (error) => settle(false, error),
    );
  }

  // ── JavaScript functions called by Python ────────────────────────

  /** Python callable running a JavaScript function (new reference). */
  #function(fn: Function & { [CANCELLABLE]?: boolean }): bigint {
    const api = this.#api;
    this.#drain();
    const id = this.#nextId++;
    const name = fn.name || "js_function";
    const def = new PyMethodDef(name, this.#trampoline.pointer, METH_VARARGS | METH_KEYWORDS, null);
    this.#functions.set(id, { fn, def, isClass: isClass(fn) }); // def must outlive the Python function
    try {
      const cfunc = this.#using(this.#check(api.PyLong_FromLongLong(id)), (self) => this.#check(api.PyCFunction_NewEx(def._buffer, self, null)));
      const native = this.#nativeObjects;
      if (native) return this.#using(cfunc, (callable) => native.createCallable(this.#check(callable), id));
      // Bootstrap must publish _op before the native factory can be constructed.
      if (this.#state !== "initializing") {
        api.Py_DecRef(cfunc);
        throw new Error("Native Python callables are not initialized");
      }
      return this.#callRaw(this.#bootstrap.wrap, [cfunc, this.#toPy(id)]);
    } catch (error) {
      this.#functions.delete(id);
      throw error;
    }
  }

  /** Release collected proxies and forget JavaScript values released by Python. */
  #drain() {
    while (this.#releasedProxies.length) this.#api.Py_DecRef(this.#releasedProxies.pop()!);
    this.#nativeObjects?.drainReleased(
      (id) => this.#functions.delete(id),
      (id) => this.#forgetObject(id),
    );
  }

  #scheduleDrain() {
    if (this.#drainScheduled || (this.#releasedProxies.length === 0 && this.#functions.size === 0 && this.#objects.size === 0)) return;
    this.#drainScheduled = true;
    setImmediate(() => {
      this.#drainScheduled = false;
      if (!this.#finalized && this.#state !== "closing") this.#withGIL(() => this.#drain());
    }).unref();
  }

  /** PyCFunction body: runs the JavaScript function. */
  #callJS(self: Pointer, args: Pointer, kw: Pointer): Pointer {
    const api = this.#api;
    // Called by Python code on the main thread, which holds the GIL.
    this.#depth++;
    try {
      const entry = this.#functions.get(api.PyLong_AsLongLong(self));
      if (!entry) throw new Error("JavaScript function has been released");
      const size = Number(api.PyTuple_Size(args));
      const jsArgs = new Array(size);
      for (let i = 0; i < size; i++) jsArgs[i] = this.#fromPy(api.PyTuple_GetItem(args, i), false, undefined, true);
      if (kw && api.PyDict_Size(kw) > 0) jsArgs.push(this.#fromPy(kw, true, undefined, true));
      if (entry.fn[CANCELLABLE]) jsArgs.push(new AbortController().signal); // a synchronous call is never cancelled
      const result: unknown = entry.isClass ? Reflect.construct(entry.fn, jsArgs) : entry.fn(...jsArgs);
      if (isThenable(result) && !this.#states.has(result)) {
        result.then(undefined, () => {}); // its outcome is lost: not an unhandled rejection
        throw new TypeError(`${entry.fn.name || "JavaScript function"}() returned a promise: await it in a coroutine`);
      }
      return this.#toPy(result);
    } catch (error) {
      this.#raise(error);
      return null;
    } finally {
      this.#depth--;
    }
  }

  /** Raise a JavaScript error in Python. */
  #raise(error: unknown): void {
    const api = this.#api;
    try {
      api.PyErr_SetRaisedException(this.#exception(error)); // steals the reference
    } catch {
      api.PyErr_SetString(this.#runtimeError, String(errorProperty(error, "message") ?? error));
    }
  }

  /** Python exception for a JavaScript error (new reference). */
  #exception(error: unknown): bigint {
    const api = this.#api;
    const pythonType = errorProperty(error, PY_TYPE);
    if (pythonType) {
      const exc = this.#builtins[String(pythonType)](errorProperty(error, "message"));
      const ptr = this.#pointer(exc);
      api.Py_IncRef(ptr);
      return ptr;
    }
    // A Python exception that went through JavaScript keeps its type.
    if (error instanceof PythonError && this.#states.get(error.exception)?.ptr) {
      const exc = this.#pointer(error.exception);
      api.Py_IncRef(exc);
      return exc;
    }
    const exc = this.#using(this.#check(api.PyUnicode_DecodeUTF8(...this.#utf8(`JavaScript ${errorProperty(error, "name") ?? "Error"}: ${errorProperty(error, "message") ?? String(error)}`), null)), (message) => {
      const tuple = this.#filled(api.PyTuple_New(1), (t) => {
        api.Py_IncRef(message);
        api.PyTuple_SetItem(t, 0, message);
      });
      return this.#using(tuple, (t) => this.#check(api.PyObject_Call(this.#runtimeError, t, null)));
    });
    try {
      // The original JavaScript error becomes the cause of the PythonError
      // if the exception comes back to JavaScript.
      const id = Number(this.#nextId++);
      this.#jsErrors.set(id, error);
      if (this.#jsErrors.size > 1000) this.#jsErrors.delete(this.#jsErrors.keys().next().value!); // never re-raised in JavaScript
      this.#status(this.#using(this.#toPy(id), (p) => api.PyObject_SetAttrString(exc, "_node_ctypes_error", p)));
      return exc;
    } catch (e) {
      api.Py_DecRef(exc);
      throw e;
    }
  }

  #utf8(text: string): [Buffer, number] {
    const bytes = Buffer.from(text, "utf8");
    return [bytes, bytes.length];
  }

  /** Current Python exception → PythonError (clears the exception). */
  #fetchError() {
    const api = this.#api;
    const exc = api.PyErr_GetRaisedException(); // normalized, with its __traceback__
    if (!exc) return new Error("Python call failed without setting an exception");

    let name = "Exception";
    let message = "";
    let traceback = "";
    let cause;
    try {
      name = this.#take<string>(api.PyType_GetName(this.#typeOf(exc)));
      message = this.#take<string>(api.PyObject_Str(exc));
      if (this.#conversions) traceback = this.#usingProxy(exc, (exception) => this.#conversions.formatException(exception));
      if (api.PyObject_HasAttrString(exc, "_node_ctypes_error") === 1) {
        const id = this.#take<number>(api.PyObject_GetAttrString(exc, "_node_ctypes_error"));
        cause = this.#jsErrors.get(id);
        this.#jsErrors.delete(id);
      }
    } catch {
      api.PyErr_Clear(); // keep what could be read
    }
    const exception = this.#wrap(exc, true); // owns the reference
    const error = new PythonError(name, message, traceback, exception);
    if (cause !== undefined) error.cause = cause;
    return error;
  }
}
