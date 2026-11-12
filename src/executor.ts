// Copyright (c) 2026 Damiano Mazzella. MIT License (see LICENSE).
import { CFUNCTYPE, Executor, c_int, c_void_p } from "node-ctypes";
import type { FFIFunction } from "node-ctypes";
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

/** Filled by the executor while the request is queued or running. */
export interface Cancellable {
  cancel?: () => void;
}
const HELPERS = ["_cancel", "_discard", "_cancelled_outcome"] as const;
type Helper = (typeof HELPERS)[number];
const SOURCE = `
import ctypes
import importlib
import threading

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
_incref = ctypes.PYFUNCTYPE(None, ctypes.py_object)(ctypes.cast(ctypes.pythonapi.Py_IncRef, ctypes.c_void_p).value)
# Reentrant only for _is_owned(): see _settle.
_lock = threading.RLock()
_ident = None
_current = None
_interrupted = False
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
            # An abort that landed after the operation completed. It can land
            # right after __enter__ acquired the lock, outside the with block's
            # protected range, so __exit__ never runs: release it here. At most
            # one abort is injected per operation, so none can land in here.
            if _lock._is_owned():
                _lock.release()

def _cancel(token):
    # Inject at most once, and only into the operation that is running. A
    # request already taken by the executor thread but not started yet (it
    # waits for the GIL) is marked: _run raises before executing it.
    global _interrupted
    with _lock:
        if token == _current:
            if not _interrupted:
                _interrupted = True
                _raise_async(_ident, _interrupt)
        else:
            _cancelled.add(token)

def _discard(token):
    # A cancellation that arrived after its request completed.
    with _lock:
        _cancelled.discard(token)

def _cancelled_outcome():
    return (False, _interrupt())

def _entry(request, token):
    # Runs on the executor thread; ctypes takes the GIL around the callback.
    # The outcome is returned as a new reference, owned by the host.
    global _ident
    _ident = _get_ident()
    try:
        outcome = (True, _run(request, token))
    except _base_error as error:
        outcome = (False, error)
    _incref(outcome)
    return id(outcome)

_entry_callback = ctypes.CFUNCTYPE(ctypes.c_void_p, ctypes.py_object, ctypes.c_int)(_entry)
_entry_address = ctypes.cast(_entry_callback, ctypes.c_void_p).value
`;

// Rejection reason of a request removed from the queue before it ran.
const CANCELLED = Symbol("cancelled");
// node-ctypes internals, not part of its typed API: the id of a call (written
// into a callOn target with `_job`) and the removal of a call still queued.
type ExecutorJobs = { _cancel(job: number, reason: unknown): boolean };

/**
 * Python requests run in order on a node-ctypes Executor thread (no libuv
 * worker waits for them). Each request is a call of a Python ctypes callback
 * on that thread; the thread keeps one Python thread state from start to close.
 */
export class PythonExecutor {
  #api: PythonLibrary;
  #namespace!: bigint;
  #check: (ptr: Pointer) => bigint;
  #withGIL: <T>(fn: () => T) => T;
  #helpers = new Map<Helper, bigint>();
  #executor!: Executor;
  #entry!: FFIFunction;
  #restoreThread!: FFIFunction;
  #releaseState!: FFIFunction;
  #attached!: Promise<[number, Pointer]>;
  #pending = new Map<number, Promise<unknown>>();
  #lastToken = 0;
  #closing: Promise<void> | undefined;
  #abandoned = false;

  constructor(api: PythonLibrary, check: (ptr: Pointer) => bigint, withGIL: <T>(fn: () => T) => T) {
    this.#api = api;
    this.#check = check;
    this.#withGIL = withGIL;
    let entry: bigint;
    try {
      this.#namespace = check(api.PyDict_New());
      if (api.PyDict_SetItemString(this.#namespace, "__builtins__", api.PyEval_GetBuiltins()) < 0) check(null);
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
      entry = BigInt(api.PyLong_AsLongLong(check(api.PyDict_GetItemString(this.#namespace, "_entry_address"))));
    } catch (error) {
      this.#releasePython();
      throw error;
    }
    // Started only once the Python side is complete: a failed setup leaves no
    // thread holding a thread state. Own bindings: the host's wrappers count
    // as host acquisitions (and tests replace them).
    this.#executor = new Executor({ name: "node-python" });
    this.#entry = CFUNCTYPE(c_void_p, c_void_p, c_int)(entry);
    this.#restoreThread = api.func("PyEval_RestoreThread", null, [c_void_p]);
    this.#releaseState = api.func("PyGILState_Release", null, [c_int]);
    // The first jobs give the executor thread a thread state and release the
    // GIL: thread-local Python state survives between requests.
    const ensure = api.func("PyGILState_Ensure", c_int, []).callOn(this.#executor) as Promise<number>;
    const save = api.func("PyEval_SaveThread", c_void_p, []).callOn(this.#executor) as Promise<Pointer>;
    this.#attached = Promise.all([ensure, save]);
    this.#attached.catch(() => undefined);
  }

  callAsync(request: Pointer, control?: Cancellable): Promise<Pointer> {
    if (this.#abandoned || this.#closing) return Promise.reject(new Error("Python executor is closing"));
    let token: number;
    try {
      token = nextCompletionToken(this.#lastToken, this.#pending);
    } catch (error) {
      return Promise.reject(error);
    }
    this.#lastToken = token;
    // Submitted without the GIL held by the host: the executor thread takes it
    // at once, and a short request completes while the host waits inline.
    const call = { executor: this.#executor, _job: 0 };
    const task = this.#entry.callOn(call, request, token) as Promise<Pointer>;
    const job = call._job;
    let cancelled = false;
    if (control)
      control.cancel = () => {
        if (cancelled || this.#abandoned) return;
        cancelled = true;
        // Still queued: removed without running. Otherwise Python interrupts it.
        if (!(this.#executor as unknown as ExecutorJobs)._cancel(job, CANCELLED)) this.#tokenHelper("_cancel", token);
      };
    const settled = task
      .then(
        (outcome) => {
          if (cancelled) this.#tokenHelper("_discard", token);
          return outcome;
        },
        (error: unknown) => {
          if (error === CANCELLED) return this.#withGIL(() => this.#call("_cancelled_outcome"));
          throw error;
        },
      )
      .finally(() => {
        if (control) control.cancel = undefined;
        this.#pending.delete(token);
      });
    this.#pending.set(token, settled);
    return settled;
  }

  #tokenHelper(name: Helper, token: number): void {
    this.#withGIL(() => {
      const id = this.#check(this.#api.PyLong_FromLongLong(token));
      try {
        this.#api.Py_DecRef(this.#call(name, [id]));
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

  close(): Promise<void> {
    this.#closing ??= this.#finish();
    return this.#closing;
  }

  async #finish(): Promise<void> {
    await Promise.allSettled([...this.#pending.values()]);
    try {
      const [state, threadState] = await this.#attached;
      // FIFO, after every accepted request: the thread state is released on
      // its own thread, then the thread stops.
      await this.#restoreThread.callOn(this.#executor, threadState);
      await this.#releaseState.callOn(this.#executor, state);
    } finally {
      await this.#executor.close();
      this.#withGIL(() => this.#releasePython());
    }
  }

  abandon(): void {
    // Forced exit retains Python owners until the OS tears down the process;
    // node-ctypes leaves the executor thread to the process exit.
    this.#abandoned = true;
  }
}
