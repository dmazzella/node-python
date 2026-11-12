import assert from "node:assert/strict";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Python, PythonError, byReference, cancellable } from "@node-ctypes/python";
import { PythonLibrary } from "../../dist/native.js";
import { PythonExecutor } from "../../dist/executor.js";
import { loadLibrary, probeInterpreter } from "../../dist/interpreter.js";
import { claimHost, releaseHost } from "../../dist/host.js";
import { CDLL, WinDLL, c_int, c_void_p, c_char_p } from "node-ctypes";
import type { NativeFunction } from "../../dist/native.js";
import { once } from "node:events";
import { Worker } from "node:worker_threads";

const scenario = process.argv[2];
const info = await probeInterpreter();
const loaded = loadLibrary(info);
const { lib } = loaded;

if (["startup-cleanup-error", "finalize-error", "multiple-errors"].includes(scenario)) {
  const original = lib.Py_FinalizeEx;
  Object.defineProperty(PythonLibrary.prototype, "Py_FinalizeEx", {
    configurable: true,
    value: mock.fn(original, () => {
      original();
      return -1;
    }),
  });
}

if (scenario === "abandoned-host") {
  const worker = new Worker(new URL("./host-worker.ts", import.meta.url));
  const exited = once(worker, "exit");
  assert.deepEqual(await once(worker, "message"), ["ready"]);
  const claimed = once(worker, "message");
  worker.postMessage("claim");
  assert.deepEqual(await claimed, [true]);
  worker.postMessage("abandon");
  assert.deepEqual(await exited, [0]);
  assert.throws(claimHost, /already has an interpreter host/);
  if (process.geteuid) console.log(`HOST_SEMAPHORE=/npy-${process.geteuid().toString(16)}-${process.pid.toString(16)}`);
} else if (scenario === "dll-directory-startup" || scenario === "dll-directory-finalize") {
  const kernel = new WinDLL("kernel32.dll");
  const remove: NativeFunction<[typeof c_void_p], typeof c_int> = kernel.RemoveDllDirectory;
  remove.argtypes = [c_void_p];
  remove.restype = c_int;
  const initialized = lib.Py_IsInitialized;
  const states: number[] = [];
  Object.defineProperty(WinDLL.prototype, "RemoveDllDirectory", {
    configurable: true,
    value: (cookie: bigint) => {
      states.push(initialized());
      return remove(cookie);
    },
  });
  try {
    if (scenario === "dll-directory-startup") {
      const failure = new Error("Injected failure after DLL registration");
      Object.defineProperty(PythonLibrary.prototype, "Py_IsInitialized", {
        configurable: true,
        value: () => {
          throw failure;
        },
      });
      await assert.rejects(
        () => Python.initialize({ stdin: false }),
        (error: unknown) => error === failure,
      );
    } else {
      const python = await Python.initialize({ stdin: false });
      assert.deepEqual(states, [], "DLL search registration must remain active while Python runs");
      assert.equal(await python.eval("6 * 7"), 42);
      await python.finalize();
      await python.finalize();
    }
    assert.deepEqual(states, [0], "the runtime must remove its own registration exactly once, with Python stopped");
  } finally {
    Reflect.deleteProperty(PythonLibrary.prototype, "Py_IsInitialized");
    Reflect.deleteProperty(WinDLL.prototype, "RemoveDllDirectory");
    kernel.close();
  }
} else if (scenario === "host-claim-error") {
  const prototype = process.platform === "win32" ? WinDLL.prototype : CDLL.prototype;
  const operation = process.platform === "win32" ? "CreateMutexW" : "sem_open";
  Object.defineProperty(prototype, operation, { configurable: true, value: () => null });
  const nativeError = mock.method(CDLL.prototype, process.platform === "win32" ? "get_last_error" : "get_errno", () => 5);
  try {
    await assert.rejects(async () => await Python.initialize({ stdin: false }), new RegExp(`${operation}.*native error 5`));
    assert.equal(lib.Py_IsInitialized(), 0, "native reservation failure must occur before CPython initialization");
  } finally {
    Reflect.deleteProperty(prototype, operation);
    nativeError.mock.restore();
  }
  const python = await Python.initialize({ stdin: false });
  assert.equal(await python.eval("6 * 7"), 42);
  await python.finalize();
} else if (scenario === "synchronous-callbacks") {
  const [major, minor] = info.version.split(".").map(Number);
  if (process.platform === "win32" && major === 3 && minor < 14) {
    await assert.rejects(() => Python.initialize({ stdin: false, synchronousCallbacks: true }), /Synchronous native callbacks require/);
    assert.equal(lib.Py_IsInitialized(), 0, "unsupported synchronous callbacks must finalize partial startup");
  } else {
    const python = await Python.initialize({ stdin: false, synchronousCallbacks: true });
    try {
      assert.equal(await python.eval('len(__import__("_node_ctypes")._native_dispatchers)'), 1);
      python.main.synchronous_shared = byReference({ answer: 42 });
      await python.exec(`
import threading
synchronous_results = []
def synchronous_read():
    synchronous_results.append(synchronous_shared.answer)
synchronous_thread = threading.Thread(target=synchronous_read, daemon=True)
synchronous_thread.start()
synchronous_thread.join(3)
assert not synchronous_thread.is_alive(), "Native getter was not served during join"
assert synchronous_results == [42]

class SynchronousWait:
    @property
    def answer(self):
        synchronous_results.clear()
        thread = threading.Thread(target=synchronous_read, daemon=True)
        thread.start()
        thread.join(3)
        assert not thread.is_alive(), "Native getter was not served during synchronous property access"
        return synchronous_results[0]
synchronous_wait = SynchronousWait()
`);
      assert.equal(python.main.synchronous_wait.answer, 42);
    } finally {
      await python.finalize();
    }
  }
} else if (scenario === "pre-initialize-error") {
  const failure = new Error("Injected failure before native initialization");
  const original = lib.Py_IsInitialized;
  const close = PythonLibrary.prototype.close;
  const closed = mock.method(PythonLibrary.prototype, "close", function (this: PythonLibrary) {
    close.call(this);
  });
  Object.defineProperty(PythonLibrary.prototype, "Py_IsInitialized", {
    configurable: true,
    value: mock.fn(original, () => {
      throw failure;
    }),
  });
  await assert.rejects(
    async () => await Python.initialize(),
    (error: unknown) => error === failure,
  );
  assert.equal(closed.mock.callCount(), 1, "failed startup must close its unused library handle");
  Reflect.deleteProperty(PythonLibrary.prototype, "Py_IsInitialized");
  closed.mock.restore();
  const python = await Python.initialize({ stdin: false });
  assert.equal(await python.eval("6 * 7"), 42);
  await python.finalize();
} else if (scenario === "executor-cache-error" || scenario === "executor-start-error") {
  const failure = new Error(`Injected ${scenario} failure`);
  const operation = scenario === "executor-cache-error" ? "PyDict_GetItemString" : "PyObject_Call";
  const lookup = lib.PyDict_GetItemString;
  Object.defineProperty(PythonLibrary.prototype, operation, {
    configurable: true,
    value: (...args: Parameters<typeof lookup>) => {
      if (operation === "PyObject_Call" || args[1] === "_entry_address") throw failure;
      return lookup(...args);
    },
  });
  try {
    await assert.rejects(
      () => Python.initialize({ stdin: false }),
      (error: unknown) => error === failure,
    );
    assert.equal(lib.Py_IsInitialized(), 0, "partial executor startup must finalize Python without starting or stranding its thread");
    await assert.rejects(() => Python.initialize(), /initialization.*failed|cannot.*initialized again/i);
  } finally {
    Reflect.deleteProperty(PythonLibrary.prototype, operation);
  }
} else if (scenario === "executor-enqueue-error" || scenario === "executor-completion-error") {
  const python = await Python.initialize({ stdin: false });
  await python.exec("executor_failure_was_run = False");
  const failure = new Error(`Injected ${scenario} failure`);
  let failed = false;
  // Enqueue: building the request tuple, before the executor accepts it.
  const original = lib.PyTuple_New;
  if (scenario === "executor-enqueue-error") {
    Object.defineProperty(PythonLibrary.prototype, "PyTuple_New", {
      configurable: true,
      value: (...args: unknown[]) => {
        if (!failed) {
          failed = true;
          throw failure;
        }
        return Reflect.apply(original, undefined, args);
      },
    });
  }
  // Completion: the executor's outcome fails after Python ran the request.
  const callAsync = PythonExecutor.prototype.callAsync;
  if (scenario === "executor-completion-error") {
    mock.method(PythonExecutor.prototype, "callAsync", function (this: PythonExecutor, ...args: Parameters<typeof callAsync>) {
      const outcome = Reflect.apply(callAsync, this, args);
      if (failed) return outcome;
      failed = true;
      return outcome.then(() => {
        throw failure;
      });
    });
  }
  try {
    await assert.rejects(
      () => python.exec("executor_failure_was_run = True"),
      (error: unknown) => error === failure,
    );
    Reflect.deleteProperty(PythonLibrary.prototype, "PyTuple_New");
    mock.restoreAll();
    assert.equal(python.main.executor_failure_was_run, scenario === "executor-completion-error", "only a completion failure may occur after accepted Python work has executed");
    assert.equal(await python.eval("6 * 7"), 42, "a completion failure must reject its request without stranding later work");
  } finally {
    Reflect.deleteProperty(PythonLibrary.prototype, "PyTuple_New");
    mock.restoreAll();
    await python.finalize();
  }
} else if (scenario === "console-output") {
  // Whole lines to console.log / console.error, as Python writes them in pieces.
  const logged: string[] = [];
  const errors: string[] = [];
  mock.method(console, "log", (line: string) => void logged.push(line));
  mock.method(console, "error", (line: string) => void errors.push(line));
  try {
    const python = await Python.initialize({ stdin: false, stdout: "console", stderr: "console" });
    try {
      await python.exec(String.raw`
import sys
print("a", "b")
print("one\ntwo")
print("partial", end="")
sys.stdout.flush()
print("err", file=sys.stderr)
print("tail", end="")
`);
      assert.deepEqual(logged, ["a b", "one", "two", "partial"]);
      assert.deepEqual(errors, ["err"]);
    } finally {
      await python.finalize();
    }
    assert.deepEqual(logged, ["a b", "one", "two", "partial", "tail"], "the pending line is emitted when Python finalizes");
  } finally {
    mock.restoreAll();
  }
} else if (scenario === "finalize-gil-contention") {
  // The executor releases its thread state at close: it must not hold the GIL
  // while waiting for this thread, which takes it here on every turn (stats()).
  // A Python thread keeps the GIL busy, so that those jobs do not complete inline.
  const python = await Python.initialize({ stdin: false });
  await python.exec(`
import threading
def spin():
    while True:
        pass
threading.Thread(target=spin, daemon=True).start()
`);
  let done = false;
  const poll = () => {
    if (done) return;
    python.stats();
    setImmediate(poll);
  };
  setImmediate(poll);
  await python.finalize();
  done = true;
} else if (scenario === "no-shared-array-buffer") {
  // As in a page that is not cross-origin isolated (an Electron renderer):
  // memory is still passed as ArrayBuffer and typed arrays.
  Reflect.deleteProperty(globalThis, "SharedArrayBuffer");
  const python = await Python.initialize({ stdin: false });
  try {
    const { len, bytes } = python.builtins;
    assert.equal(await len(new ArrayBuffer(4)), 4);
    assert.equal(await len(new Float64Array(3)), 3);
    assert.deepEqual([...(await bytes(new Uint8Array([1, 2, 3])))], [1, 2, 3]);
    await python.exec(`
def fill(view):
    view[0] = 7
`);
    const shared = new Uint8Array(2);
    await python.main.fill(byReference(shared.buffer));
    assert.equal(shared[0], 7, "byReference shares the ArrayBuffer memory");
  } finally {
    await python.finalize();
  }
} else if (scenario === "native-objects-error") {
  const failure = new Error("Injected native object type failure");
  Object.defineProperty(PythonLibrary.prototype, "PyType_FromSpecWithBases", {
    configurable: true,
    value: () => {
      throw failure;
    },
  });
  await assert.rejects(
    async () => await Python.initialize({ stdin: false }),
    (error: unknown) => error === failure,
  );
  assert.equal(lib.Py_IsInitialized(), 0, "native object failure must finalize startup, never select another implementation");
  await assert.rejects(async () => await Python.initialize(), /initialization.*failed|cannot.*initialized again/i);
} else if (scenario === "startup-early" || scenario === "startup-late" || scenario === "startup-cleanup-error") {
  const failure = new Error(`Injected ${scenario} failure`);
  if (scenario === "startup-early") {
    const original = lib.PyImport_ImportModule;
    Object.defineProperty(PythonLibrary.prototype, "PyImport_ImportModule", {
      configurable: true,
      value: mock.fn(original, (...args: Parameters<typeof original>) => {
        if (args[0] === "__main__") throw failure;
        return original(...args);
      }),
    });
  } else {
    const original = lib.PyObject_SetAttrString;
    Object.defineProperty(PythonLibrary.prototype, "PyObject_SetAttrString", {
      configurable: true,
      value: mock.fn(original, (...args: Parameters<typeof original>) => {
        if (args[1] === "argv") throw failure;
        return original(...args);
      }),
    });
  }
  await assert.rejects(
    async () => await Python.initialize({ stdin: false }),
    (error: unknown) => {
      if (scenario !== "startup-cleanup-error") return error === failure;
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], failure);
      assert.ok(error.errors[1] instanceof Error);
      assert.match(error.errors[1].message, /Py_FinalizeEx/);
      return true;
    },
  );
  assert.equal(lib.Py_IsInitialized(), 0, "partial startup must finalize the owned interpreter");
  await assert.rejects(async () => await Python.initialize(), /initialization.*failed|cannot.*initialized again/i);
} else if (scenario === "host-release-error") {
  const windows = process.platform === "win32";
  const library = windows ? new WinDLL("kernel32.dll") : new CDLL(null);
  const prototype = windows ? WinDLL.prototype : CDLL.prototype;
  const operation = windows ? "ReleaseMutex" : "sem_unlink";
  const original: NativeFunction<[typeof c_void_p | typeof c_char_p], typeof c_int> = library[operation];
  original.argtypes = [windows ? c_void_p : c_char_p];
  original.restype = c_int;
  let failing = false;
  Object.defineProperty(prototype, operation, {
    configurable: true,
    value: (...args: Parameters<typeof original>) => (failing ? (windows ? 0 : -1) : original(...args)),
  });
  try {
    const python = await Python.initialize({ stdin: false });
    failing = true;
    await assert.rejects(async () => await python.finalize(), new RegExp(operation));
    assert.equal(lib.Py_IsInitialized(), 0);
    assert.equal(python.stats().functions, 0, "native release failure must not interrupt runtime cleanup");
    assert.equal(python.stats().objects, 0);
    assert.throws(claimHost, /already has an interpreter host/);
  } finally {
    failing = false;
    releaseHost();
    Reflect.deleteProperty(prototype, operation);
    library.close();
  }
  claimHost();
  releaseHost();
} else if (scenario === "finalize-error") {
  const python = await Python.initialize({ stdin: false });
  await assert.rejects(async () => await python.finalize(), /Py_FinalizeEx/);
  assert.equal(lib.Py_IsInitialized(), 0);
  assert.deepEqual(python.stats().awaits, 0);
  await python.finalize();
  await assert.rejects(async () => await Python.initialize(), /finalized/i);
} else if (scenario === "shutdown-error" || scenario === "multiple-errors") {
  const failure = new Error("Injected bridge shutdown failure");
  const call = lib.PyObject_Call;
  let closing = false;
  Object.defineProperty(PythonLibrary.prototype, "PyObject_Call", {
    configurable: true,
    value: mock.fn(call, (...args: Parameters<typeof call>) => {
      if (closing) {
        closing = false;
        throw failure;
      }
      return call(...args);
    }),
  });
  const python = await Python.initialize({ stdin: false });
  closing = true;
  await assert.rejects(
    async () => await python.finalize(),
    (error: unknown) => {
      if (scenario === "shutdown-error") return error === failure;
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], failure);
      assert.ok(error.errors[1] instanceof Error);
      assert.match(error.errors[1].message, /Py_FinalizeEx/);
      return true;
    },
  );
  assert.equal(lib.Py_IsInitialized(), 0, "native finalization must run even when bridge shutdown fails");
  assert.equal(python.stats().functions, 0);
  assert.equal(python.stats().objects, 0);
  await python.finalize();
} else if (scenario === "switch-interval") {
  for (const switchInterval of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5"]) {
    await assert.rejects(async () => await Python.initialize({ stdin: false, switchInterval: switchInterval as number }), /switchInterval must be a positive number/);
  }
  assert.equal(lib.Py_IsInitialized(), 0, "an invalid switch interval must be rejected before CPython starts");
  const python = await Python.initialize({ stdin: false });
  assert.equal(await python.eval("__import__('sys').getswitchinterval()"), 0.005);
  await python.finalize();
} else if (scenario === "switch-interval-explicit") {
  const python = await Python.initialize({ stdin: false, switchInterval: 0.5 });
  assert.equal(await python.eval("__import__('sys').getswitchinterval()"), 0.0005);
  await python.finalize();
} else if (scenario === "stats-finalize") {
  const python = await Python.initialize({ stdin: false });
  const json = await python.import("json");
  assert.ok(python.stats().proxies > 0);
  const closing = python.finalize();
  for (let turn = 0; turn < 5; turn++) {
    assert.equal(typeof python.stats().proxies, "number", "stats() must stay readable while Python is closing");
    await new Promise((resolve) => setImmediate(resolve));
  }
  await closing;
  assert.deepEqual(python.stats(), { proxies: 0, functions: 0, objects: 0, awaits: 0, calls: 0 });
  assert.throws(() => String(json), /finalized/);
} else if (scenario === "reentrant-finalize") {
  const python = await Python.initialize({ stdin: false });
  try {
    let reentrant: Promise<void> | undefined;
    python.module("lifecycle", { close: () => (reentrant = python.finalize()) });
    await assert.rejects(
      async () => await python.exec("import lifecycle\nlifecycle.close()"),
      (error: unknown) => error instanceof PythonError && error.cause instanceof TypeError && /returned a promise.*coroutine/i.test(error.cause.message),
    );
    assert.ok(reentrant);
    await assert.rejects(reentrant, /callback|executing Python/i);
    assert.equal(await python.eval("6 * 7"), 42);
  } finally {
    await python.finalize();
  }
} else if (scenario === "exit-abandon-error" || scenario === "exit-abandon-error-pending") {
  const failure = new Error("Injected executor abandonment failure");
  const abandon = mock.method(PythonExecutor.prototype, "abandon", () => {
    throw failure;
  });
  const saveThread = mock.fn(lib.PyEval_SaveThread);
  Object.defineProperty(PythonLibrary.prototype, "PyEval_SaveThread", { configurable: true, value: saveThread });
  const python = await Python.initialize({ stdin: false });
  try {
    const savesBeforeExit = saveThread.mock.callCount();
    if (scenario === "exit-abandon-error") {
      python.module("lifecycle", { exit: () => process.exit(0) });
      await assert.rejects(
        () => python.exec("import lifecycle\nlifecycle.exit()"),
        (error: unknown) => {
          if (!(error instanceof PythonError)) return false;
          try {
            assert.equal(error.type, "RuntimeError");
            assert.equal(error.cause, failure);
            return true;
          } finally {
            error.exception[Symbol.dispose]();
          }
        },
      );
    } else {
      const accepted = python.exec("import time\ntime.sleep(0.02)");
      assert.throws(
        () => process.exit(0),
        (error: unknown) => error === failure,
      );
      await accepted;
    }
    assert.equal(saveThread.mock.callCount(), savesBeforeExit, "failed abandonment must not detach the callback's Python thread");
    assert.equal(await python.eval("6 * 7"), 42, "Python must remain usable while an abandonment error unwinds");
  } finally {
    abandon.mock.restore();
    Reflect.deleteProperty(PythonLibrary.prototype, "PyEval_SaveThread");
    await python.finalize();
  }
  console.log("EXIT_ABANDON_ERROR_PROPAGATED");
} else if (scenario === "exit-callback") {
  const python = await Python.initialize({ stdin: false });
  python.module("lifecycle", {
    exit: () => {
      if (process.geteuid) console.log(`HOST_SEMAPHORE=/npy-${process.geteuid().toString(16)}-${process.pid.toString(16)}`);
      process.exit(0);
    },
  });
  await python.exec("import lifecycle\nlifecycle.exit()");
  assert.fail("process.exit must not return");
} else if (scenario === "pending-error-dispose") {
  const python = await Python.initialize({ stdin: false });
  try {
    await python.exec("def pending_failure():\n    raise ValueError('pending error disposal')");
    const failure = python.main.pending_failure;
    const owned = python.toPython([42]);
    const rejected = failure().then(
      () => assert.fail("the accepted call must reject"),
      (error: unknown) => {
        assert.ok(error instanceof PythonError);
        assert.equal(error.type, "ValueError");
        error.exception[Symbol.dispose]();
        error.exception[Symbol.dispose]();
        owned[Symbol.dispose]();
        owned[Symbol.dispose]();
      },
    );
    await Promise.all([rejected, python.finalize()]);
    assert.equal(lib.Py_IsInitialized(), 0);
    assert.throws(() => owned.toJS(), /finaliz|released/i);
  } finally {
    await python.finalize();
  }
} else if (scenario === "pending-calls") {
  const python = await Python.initialize({ stdin: false });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborted = false;
  python.module("lifecycle", {
    wait: cancellable((signal: AbortSignal) => {
      started();
      return new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          async () => {
            aborted = true;
            await assert.rejects(async () => await python.eval("1"), /closing|finaliz/i);
            resolve();
          },
          { once: true },
        );
      });
    }),
  });
  await python.exec("async def pending():\n    import lifecycle\n    await lifecycle.wait()");
  const work = Promise.resolve(python.main.pending());
  const rejected = assert.rejects(work, /finalized/i);
  await ready;
  await python.finalize();
  assert.ok(aborted, "shutdown must abort active cancellable JavaScript calls");
  await rejected;
  await delay(0);
  const { functions, objects, awaits, calls } = python.stats();
  assert.deepEqual({ functions, objects, awaits, calls }, { functions: 0, objects: 0, awaits: 0, calls: 0 });
} else if (scenario === "pending-thread-callback") {
  const python = await Python.initialize({ stdin: false });
  python.module("lifecycle", { answer: () => 42 });
  await python.exec(`
import threading, lifecycle
def threaded_while_closing():
    values = []
    def worker():
        values.append(lifecycle.answer().result())
    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    thread.join(3)
    assert not thread.is_alive(), "callback must be served while native work drains"
    return values[0]
`);
  const work = python.main.threaded_while_closing();
  const closing = python.finalize();
  const [answer] = await Promise.all([work, closing]);
  assert.equal(answer, 42);
  assert.equal(lib.Py_IsInitialized(), 0, "closing must finish after the accepted threaded call");
  assert.equal(python.stats().calls, 0);
} else if (scenario === "late-result") {
  const python = await Python.initialize({ stdin: false });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let complete!: (value: number) => void;
  python.module("lifecycle", {
    wait: () =>
      new Promise<number>((resolve) => {
        complete = resolve;
        started();
      }),
  });
  await python.exec("async def pending():\n    import lifecycle\n    return await lifecycle.wait()");
  const work = Promise.resolve(python.main.pending());
  const rejected = assert.rejects(work, /finalized/i);
  await ready;
  await python.finalize();
  await rejected;
  complete(42);
  await delay(0);
  assert.equal(python.stats().calls, 0);
} else if (scenario === "loop-start-error") {
  const python = await Python.initialize({ stdin: false });
  await python.exec(`
import asyncio
saved_set_event_loop = asyncio.set_event_loop
def failed_set_event_loop(loop):
    raise RuntimeError("Injected event-loop startup failure")
asyncio.set_event_loop = failed_set_event_loop
async def loop_start_work():
    return 42
`);
  const coroutine = python.main.loop_start_work();
  try {
    await assert.rejects(Promise.resolve(coroutine), (error: unknown) => {
      if (!(error instanceof PythonError)) return false;
      try {
        return error.type === "RuntimeError" && /event-loop startup failure/.test(error.message);
      } finally {
        error.exception[Symbol.dispose]();
      }
    });
    assert.equal(python.stats().awaits, 0);
  } finally {
    await python.exec("asyncio.set_event_loop = saved_set_event_loop\ndel saved_set_event_loop, failed_set_event_loop");
  }
  assert.equal(await python.main.loop_start_work(), 42);
  await python.finalize();
  assert.equal(lib.Py_IsInitialized(), 0);
} else if (scenario === "atexit-callback") {
  const python = await Python.initialize({ stdin: false });
  let called = 0;
  python.module("lifecycle", {
    on_exit: () => {
      called++;
      return 42;
    },
  });
  await python.exec("import atexit, lifecycle\natexit.register(lifecycle.on_exit)");
  await python.finalize();
  assert.equal(called, 1, "Python atexit must call JavaScript during native finalization");
  assert.equal(lib.Py_IsInitialized(), 0);
} else if (scenario === "async-shutdown-error") {
  const python = await Python.initialize({ stdin: false });
  await python.exec("async def warm_loop():\n    return 42");
  assert.equal(await python.main.warm_loop(), 42);
  await python.exec(`
import asyncio
def failed_all_tasks(*args, **kwargs):
    raise RuntimeError("Injected asyncio cleanup failure")
asyncio.all_tasks = failed_all_tasks
`);
  await assert.rejects(
    async () => await python.finalize(),
    (error: unknown) => error instanceof PythonError && error.type === "RuntimeError" && /asyncio cleanup failure/.test(error.message),
  );
  assert.equal(lib.Py_IsInitialized(), 0);
  assert.equal(python.stats().awaits, 0);
  await python.finalize();
} else {
  throw new Error(`Unknown lifecycle scenario: ${scenario}`);
}

lib.close();
loaded.release?.();
