// Copyright (c) 2026 Damiano Mazzella. MIT License (see LICENSE).
import { setImmediate } from "node:timers/promises";
import { c_int, threadSafeCallback } from "node-ctypes";
import type { ThreadSafeCallbackWrapper } from "node-ctypes";
import { Py_file_input } from "./native.ts";
import type { PythonLibrary } from "./native.ts";

type Pointer = bigint | null;
export function nextCompletionToken(previous: number, pending: ReadonlyMap<number, unknown>): number {
  if (pending.size >= 0x7fffffff) throw new RangeError("Python executor has no free completion identifiers");
  let token = previous;
  do {
    token = token === 0x7fffffff ? 1 : token + 1;
  } while (pending.has(token));
  return token;
}

type Pending = { promise: Promise<Pointer>; resolve: (value: Pointer) => void; reject: (error: unknown) => void; control?: Cancellable };
/** Filled by the executor while the request is queued or running. */
export interface Cancellable {
  cancel?: () => void;
}
const HELPERS = ["_enqueue", "_take", "_stop_request", "_alive", "_start", "_cancel"] as const;
type Helper = (typeof HELPERS)[number];
const SOURCE = `
import ctypes
import importlib
import queue
import threading

_queue = queue.SimpleQueue()
_sentinel = object()
_completed = {}
_notify = ctypes.CFUNCTYPE(None, ctypes.c_int)(_notify_address)
_base_error = BaseException
_interrupt = KeyboardInterrupt
_compile = compile
_eval = eval
_import = importlib.import_module
_get_ident = threading.get_ident
# Private prototypes: user code may configure ctypes.pythonapi differently.
_async_exc = ctypes.cast(ctypes.pythonapi.PyThreadState_SetAsyncExc, ctypes.c_void_p).value
_raise_async = ctypes.PYFUNCTYPE(ctypes.c_int, ctypes.c_ulong, ctypes.py_object)(_async_exc)
_clear_async = ctypes.PYFUNCTYPE(ctypes.c_int, ctypes.c_ulong, ctypes.c_void_p)(_async_exc)
_lock = threading.Lock()
_ident = None
_current = None
_interrupted = False
_waiting = set()
_cancelled = set()

def _execute(request):
    operation, *args = request
    if operation == "PyImport_ImportModule":
        return _import(args[0])
    if operation == "ExecuteSource":
        source, mode, namespace = args
        if mode not in (257, 258):
            raise ValueError(f"Unknown Python compilation mode: {mode}")
        return _eval(_compile(source, "<string>", "exec" if mode == 257 else "eval"), namespace, namespace)
    if operation == "PyObject_Call":
        function, positional, keywords = args
        return function(*positional) if keywords is None else function(*positional, **keywords)
    raise ValueError(f"Unknown Python execution operation: {operation}")

def _run(request, token):
    global _current, _interrupted
    with _lock:
        _waiting.discard(token)
        if token in _cancelled:
            _cancelled.discard(token)
            raise _interrupt
        _current = token
        _interrupted = False
    try:
        return _execute(request)
    finally:
        _settle()

def _settle():
    global _current
    while True:
        try:
            with _lock:
                _current = None
                _clear_async(_ident, None)
            return
        except _base_error:
            pass  # an abort that landed after the operation completed

def _cancel(token):
    # Inject at most once, and only into the operation that is running: a
    # late interrupt can leave _current stale, never pending for the next one.
    global _interrupted
    with _lock:
        if token == _current:
            if not _interrupted:
                _interrupted = True
                _raise_async(_ident, _interrupt)
        elif token in _waiting:
            _cancelled.add(token)

def _enqueue(request, token):
    with _lock:
        _waiting.add(token)
    _queue.put((request, token))

def _stop_request(token):
    _queue.put((_sentinel, token))

def _take(token):
    return _completed.pop(token)

def _alive():
    return _thread.is_alive()

def _start():
    _thread.start()

def _work():
    global _ident
    _ident = _get_ident()
    while True:
        request, token = _queue.get()
        stopping = request is _sentinel
        try:
            outcome = (True, None if stopping else _run(request, token))
        except _base_error as error:
            outcome = (False, error)
        _completed[token] = outcome
        del request, outcome
        _notify(token)
        del token
        if stopping:
            return

_thread = threading.Thread(target=_work, name="node-python", daemon=True)
`;

/** Python owns execution; completion notifications do not occupy libuv workers. */
export class PythonExecutor {
  #api: PythonLibrary;
  #namespace!: bigint;
  #channel!: ThreadSafeCallbackWrapper;
  #check: (ptr: Pointer) => bigint;
  #withGIL: <T>(fn: () => T) => T;
  #consume: (outcome: Pointer) => Pointer;
  #helpers = new Map<Helper, bigint>();
  #pending = new Map<number, Pending>();
  #lastToken = 0;
  #closing: Promise<void> | undefined;
  #abandoned = false;

  constructor(api: PythonLibrary, check: (ptr: Pointer) => bigint, withGIL: <T>(fn: () => T) => T, consume: (outcome: Pointer) => Pointer) {
    this.#api = api;
    this.#check = check;
    this.#withGIL = withGIL;
    this.#consume = consume;
    try {
      this.#namespace = check(api.PyDict_New());
      this.#channel = threadSafeCallback((token) => this.#complete(token), null, [c_int]).unref();
      if (api.PyDict_SetItemString(this.#namespace, "__builtins__", api.PyEval_GetBuiltins()) < 0) check(null);
      const address = check(api.PyLong_FromLongLong(this.#channel.pointer));
      try {
        if (api.PyDict_SetItemString(this.#namespace, "_notify_address", address) < 0) check(null);
      } finally {
        api.Py_DecRef(address);
      }
      const code = check(api.Py_CompileString(SOURCE, "<node-python executor>", Py_file_input));
      try {
        api.Py_DecRef(check(api.PyEval_EvalCode(code, this.#namespace, this.#namespace)));
      } finally {
        api.Py_DecRef(code);
      }
      for (const name of HELPERS) {
        const helper = check(api.PyDict_GetItemString(this.#namespace, name));
        api.Py_IncRef(helper);
        this.#helpers.set(name, helper);
      }
      api.Py_DecRef(this.#call("_start"));
    } catch (error) {
      this.#releasePython();
      this.#channel?.release();
      throw error;
    }
  }

  callAsync(request: Pointer, control?: Cancellable): Promise<Pointer> {
    if (this.#abandoned || this.#closing) return Promise.reject(new Error("Python executor is closing"));
    return this.#dispatch(request, false, control);
  }

  #cancel(token: number): void {
    if (this.#abandoned || !this.#pending.has(token)) return;
    this.#withGIL(() => {
      const id = this.#check(this.#api.PyLong_FromLongLong(token));
      try {
        this.#api.Py_DecRef(this.#call("_cancel", [id]));
      } finally {
        this.#api.Py_DecRef(id);
      }
    });
  }

  #call(name: Helper, args: Pointer[] = []): bigint {
    const helper = this.#helpers.get(name);
    if (helper === undefined) throw new Error(`Python executor helper is unavailable: ${name}`);
    const tuple = this.#check(this.#api.PyTuple_New(args.length));
    try {
      args.forEach((value, index) => {
        this.#api.Py_IncRef(this.#check(value));
        if (this.#api.PyTuple_SetItem(tuple, index, value) < 0) this.#check(null);
      });
      return this.#check(this.#api.PyObject_Call(helper, tuple, null));
    } finally {
      this.#api.Py_DecRef(tuple);
    }
  }

  #releasePython(): void {
    for (const helper of this.#helpers.values()) this.#api.Py_DecRef(helper);
    this.#helpers.clear();
    if (this.#namespace) this.#api.Py_DecRef(this.#namespace);
  }

  #dispatch(request: Pointer, stopping = false, control?: Cancellable): Promise<Pointer> {
    let token: number;
    try {
      token = nextCompletionToken(this.#lastToken, this.#pending);
    } catch (error) {
      return Promise.reject(error);
    }
    this.#lastToken = token;
    let resolve!: Pending["resolve"];
    let reject!: Pending["reject"];
    const promise = new Promise<Pointer>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    this.#pending.set(token, { promise, resolve, reject, control });
    if (this.#pending.size === 1) this.#channel.ref();
    try {
      this.#withGIL(() => {
        const id = this.#check(this.#api.PyLong_FromLongLong(token));
        try {
          this.#api.Py_DecRef(this.#call(stopping ? "_stop_request" : "_enqueue", stopping ? [id] : [request, id]));
        } finally {
          this.#api.Py_DecRef(id);
        }
      });
      if (control) control.cancel = () => this.#cancel(token);
    } catch (error) {
      this.#pending.delete(token);
      if (this.#pending.size === 0) this.#channel.unref();
      reject(error);
    }
    return promise;
  }

  #complete(token: number): void {
    if (this.#abandoned) return;
    const pending = this.#pending.get(token);
    if (!pending) throw new Error(`Unknown Python executor completion: ${token}`);
    this.#pending.delete(token);
    if (pending.control) pending.control.cancel = undefined;
    try {
      const outcome = this.#withGIL(() => {
        const id = this.#check(this.#api.PyLong_FromLongLong(token));
        try {
          return this.#call("_take", [id]);
        } finally {
          this.#api.Py_DecRef(id);
        }
      });
      pending.resolve(outcome);
    } catch (error) {
      pending.reject(error);
    } finally {
      if (this.#pending.size === 0) this.#channel.unref();
    }
  }

  close(): Promise<void> {
    this.#closing ??= this.#finish();
    return this.#closing;
  }

  async #finish(): Promise<void> {
    await Promise.allSettled([...this.#pending.values()].map(({ promise }) => promise));
    const outcome = await this.#dispatch(null, true);
    try {
      this.#withGIL(() => this.#api.Py_DecRef(this.#consume(outcome)));
    } finally {
      // A completion can arrive before its native callback returns on Python.
      while (
        this.#withGIL(() => {
          const alive = this.#call("_alive");
          try {
            const result = this.#api.PyObject_IsTrue(alive);
            if (result < 0) this.#check(null);
            return result !== 0;
          } finally {
            this.#api.Py_DecRef(alive);
          }
        })
      ) {
        await setImmediate();
      }
      this.#withGIL(() => this.#releasePython());
      this.#channel.release();
    }
  }

  abandon(): void {
    // Forced exit retains Python/callback owners until the OS tears down the process.
    this.#abandoned = true;
    this.#channel.unref();
  }
}
