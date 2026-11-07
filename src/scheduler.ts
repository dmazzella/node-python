// Copyright (c) 2026 Damiano Mazzella. MIT License (see LICENSE).
import { definePython } from "./bootstrap.ts";
import { PythonError, Tuple, kwargs } from "./values.ts";
import type { InternalPythonObject as PythonObject } from "./types.ts";

// These adapters execute on Python caller/loop/notifier threads, never as JS callbacks.
const THREAD_ADAPTERS = `
def _notifier():
    while True:
        event = _events.get()
        if event is None: return
        notify, kind, token = event
        notify(kind, token)

def _send(kind, token, request=None):
    with _lock:
        if _closing:
            raise RuntimeError("Python is finalizing: JavaScript cannot be called")
        if request is not None: _requests[token] = request
        try:
            if _notify is None: _queued.append((kind, token))
            else: _events.put((_notify, kind, token))
        except BaseException:
            if request is not None: _requests.pop(token, None)
            raise

def _run_loop(ready):
    global _loop_error
    try:
        asyncio.set_event_loop(_loop)
    except BaseException as error:
        _loop_error = error
    finally:
        ready.set()
    if _loop_error is not None: return
    _loop.run_forever()

def _await(awaitable):
    if asyncio.iscoroutine(awaitable): return awaitable
    async def wait():
        return await awaitable
    return wait()

def _completed(token, future):
    if not _closing: _send(0, token)

async def _anext(iterator):
    try: return False, await anext(iterator)
    except StopAsyncIteration: return True, None

async def _cancel_async(loop):
    tasks = [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]
    for task in tasks: task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    await loop.shutdown_asyncgens()

def _shutdown_loop():
    future = asyncio.run_coroutine_threadsafe(_cancel_async(_loop), _loop)
    try:
        future.result(timeout=2)
    finally:
        _loop.call_soon_threadsafe(_loop.stop)

class JsFuture(concurrent_futures.Future):
    name = "a JavaScript function"
    def result(self, timeout=None):
        if timeout is not None or self.done():
            return super().result(timeout)
        try:
            return super().result(5)
        except TimeoutError:
            if _main_busy is not None and _main_busy.value:
                warnings.warn(
                    f"{self.name} has been waiting for 5 s while the Node.js main thread runs Python code "
                    "(a synchronous call from JavaScript). If that code waits for this thread (Thread.join(), "
                    "future.result()), this is a deadlock: an async JavaScript function needs the Node.js event "
                    "loop, and on Windows before Python 3.14 a blocked main thread cannot run JavaScript calls. Await the work from "
                    "JavaScript instead.", RuntimeWarning, stacklevel=2)
        return super().result()

def _call_later(fid, args, kwargs, function, awaitable=True):
    future = JsFuture()
    future.name = f"JavaScript function {function.__name__}()"
    token = next(_tokens)
    _send(1, token, (fid, args, kwargs, future, function))
    if _main_busy is not None and _main_busy.value: _wake_main(token)
    future.add_done_callback(lambda f: f.cancelled() and _cancel(token))
    if not awaitable: return future
    try: return asyncio.wrap_future(future, loop=asyncio.get_running_loop())
    except RuntimeError: return future

def _cancel(token):
    with _lock:
        if (1, token) in _queued:
            _queued.remove((1, token))
            _requests.pop(token, None)
            return
    if not _closing: _send(2, token)

def _serve(token):
    global _drains
    try:
        native = _native_dispatchers.get(token)
        if native is not None:
            _drains += 1  # before draining: the snapshot includes every call queued so far
            native[0]()
        elif token in _requests: _op("serve", token)
    except BaseException:
        traceback.print_exc()

def _serve_waiting(*_):
    for token in list(_requests) + list(_native_dispatchers): _serve(token)

def _serve_pending(token):
    if _interrupt_event: _kernel32.ResetEvent(_interrupt_event)
    _serve(token)
    return 0

def _wake_main(token):
    if _wakeup is not None:
        signal.pthread_kill(_main, _wakeup)
        return True
    queued = _add_pending_call(_serve_pending_c, token) == 0
    if _interrupt_event: _kernel32.SetEvent(_interrupt_event)
    return queued

def register_native_dispatcher(dispatch):
    if _closing: raise RuntimeError("Python is finalizing")
    if _wakeup is None and not _interrupt_event:
        raise RuntimeError("Synchronous native callbacks require an available SIGURG wakeup or Windows Python 3.14+")
    token = next(_tokens)
    def notify():
        # A free-threaded main thread can miss a wakeup that lands just before
        # it parks (e.g. in Thread.join()): repeat it until a drain starts after
        # this call was queued, or the main thread stops running Python.
        drains, delay = _drains, 0.001
        while _main_busy is not None and _main_busy.value and _drains == drains:
            _wake_main(token)
            time.sleep(delay)
            delay = min(delay * 2, 0.05)
    callback = _NATIVE_NOTIFY(notify)
    _native_dispatchers[token] = (dispatch, callback)
    return token, str(ctypes.cast(callback, ctypes.c_void_p).value)

def unregister_native_dispatcher(token):
    del _native_dispatchers[token]
`;

export class PythonScheduler {
  #builtins: PythonObject;
  #module: PythonObject;
  #inspect: PythonObject;
  #operator: PythonObject;
  #functools: PythonObject;
  #sys: PythonObject;
  #publicRequest: PythonObject;
  #heldRequest: PythonObject;
  #raiseException: (exception: PythonObject) => never;

  constructor(builtins: PythonObject, importModule: (name: string) => PythonObject, module: PythonObject, busyAddress: bigint, raiseException: (exception: PythonObject) => never, wakeup = false) {
    this.#builtins = builtins;
    this.#module = module;
    this.#inspect = importModule("inspect");
    this.#operator = importModule("operator");
    this.#functools = importModule("functools");
    this.#sys = importModule("sys");
    this.#raiseException = raiseException;
    this.#publicRequest = builtins.slice(null, 3);
    this.#heldRequest = builtins.slice(3, null);
    for (const [name, library] of Object.entries({
      asyncio: "asyncio",
      concurrent_futures: "concurrent.futures",
      ctypes: "ctypes",
      signal: "signal",
      time: "time",
      traceback: "traceback",
      warnings: "warnings",
    }))
      module[name] = importModule(library);
    module._lock = module.threading.Lock();
    module._events = importModule("queue").SimpleQueue();
    module._queued = builtins.list();
    module._requests = builtins.dict();
    module._calls = builtins.dict();
    module._tokens = importModule("itertools").count(1);
    module._closing = false;
    module._loop = null;
    module._loop_error = null;
    module._notify = null;
    module._wakeup = null;
    module._interrupt_event = null;
    module._native_dispatchers = builtins.dict();
    module._drains = 0;
    module._main_busy = module.ctypes.c_int.from_address(busyAddress);
    module._NOTIFY = module.ctypes.CFUNCTYPE(null, module.ctypes.c_int, module.ctypes.c_int);
    module._NATIVE_NOTIFY = module.ctypes.CFUNCTYPE(null);
    module._PENDING = module.ctypes.CFUNCTYPE(module.ctypes.c_int, module.ctypes.c_void_p);
    module._add_pending_call = module.ctypes.pythonapi.Py_AddPendingCall;
    module._add_pending_call.argtypes = Tuple.of(module._PENDING, module.ctypes.c_void_p);
    definePython(builtins, module, THREAD_ADAPTERS, "<node-python thread adapters>");
    module._serve_pending_c = module._PENDING(module._serve_pending);
    if (wakeup) this.#installWakeup();
  }

  #installWakeup(): void {
    const m = this.#module;
    if (this.#sys.platform === "win32") {
      if (this.#sys.version_info[0] > 3 || this.#sys.version_info[1] >= 14) {
        try {
          const event = m.ctypes.pythonapi._PyOS_SigintEvent;
          event.restype = m.ctypes.c_void_p;
          m._interrupt_event = event();
          m._kernel32 = m.ctypes.WinDLL("kernel32");
          m._kernel32.SetEvent.argtypes = m._kernel32.ResetEvent.argtypes = Tuple.of(m.ctypes.c_void_p);
        } catch (error) {
          if (!(error instanceof PythonError) || !["AttributeError", "OSError"].includes(error.type)) throw error;
          error.exception[Symbol.dispose]();
          m._interrupt_event = null;
        }
      }
      return;
    }
    if (!this.#builtins.hasattr(m.signal, "pthread_kill") || !this.#builtins.hasattr(m.signal, "SIGURG")) return;
    const current = m.signal.getsignal(m.signal.SIGURG);
    if (current !== null && !this.#operator.eq(current, m.signal.SIG_DFL) && !this.#operator.eq(current, m.signal.SIG_IGN)) return;
    m.signal.signal(m.signal.SIGURG, m._serve_waiting);
    m._wakeup = m.signal.SIGURG;
  }

  isAwaitable(object: PythonObject): boolean {
    return this.#inspect.isawaitable(object) || this.#builtins.isinstance(object, this.#module.concurrent_futures.Future);
  }

  isAsyncIterable(object: PythonObject): boolean {
    return this.#builtins.hasattr(this.#builtins.type(object), "__aiter__");
  }

  asyncIterator(object: PythonObject): PythonObject {
    return this.#builtins.aiter(object);
  }

  next(iterator: PythonObject): PythonObject {
    return this.#module._anext(iterator);
  }

  closeIterator(iterator: PythonObject): unknown {
    const close = this.#builtins.getattr(iterator, "aclose", null);
    return close === null ? null : close();
  }

  #startLoop(): void {
    const m = this.#module;
    m._lock.acquire();
    try {
      if (m._loop !== null) return;
      m._loop = m.asyncio.new_event_loop();
      m._loop_error = null;
    } finally {
      m._lock.release();
    }
    const ready = m.threading.Event();
    const thread = m.threading.Thread(kwargs({ target: m._run_loop, args: Tuple.of(ready), name: "asyncio", daemon: true }));
    try {
      thread.start();
      ready.wait();
      if (m._loop_error !== null) {
        const error: PythonObject = m._loop_error;
        m._loop_error = null;
        m._loop.close();
        m._loop = null;
        this.#raiseException(error);
      }
    } finally {
      ready[Symbol.dispose]();
      thread[Symbol.dispose]();
    }
  }

  submit(awaitable: PythonObject, token: number): PythonObject {
    const m = this.#module;
    let future: PythonObject;
    if (this.#builtins.isinstance(awaitable, m.concurrent_futures.Future)) future = awaitable;
    else {
      this.#startLoop();
      const coroutine = m._await(awaitable);
      try {
        future = m.asyncio.run_coroutine_threadsafe(coroutine, m._loop);
      } finally {
        coroutine[Symbol.dispose]();
      }
    }
    const complete = this.#functools.partial(m._completed, token);
    try {
      future.add_done_callback(complete);
      return future;
    } finally {
      complete[Symbol.dispose]();
    }
  }

  openChannel(address: bigint): void {
    const m = this.#module;
    const thread = m.threading.Thread(kwargs({ target: m._notifier, name: "node-ctypes-notifier", daemon: true }));
    try {
      thread.start();
    } finally {
      thread[Symbol.dispose]();
    }
    m._lock.acquire();
    try {
      m._notify = m._NOTIFY(address);
      for (const event of m._queued) m._events.put(Tuple.of(m._notify, ...event));
      m._queued.clear();
    } finally {
      m._lock.release();
    }
  }

  takeRequest(token: number): PythonObject | null {
    const m = this.#module;
    const request = m._requests.pop(token, null);
    if (request === null) return null;
    try {
      const future: PythonObject = request[3];
      try {
        if (future.cancelled()) return null;
      } finally {
        future[Symbol.dispose]();
      }
      const held = this.#operator.getitem(request, this.#heldRequest);
      try {
        m._calls[token] = held;
      } finally {
        held[Symbol.dispose]();
      }
      return this.#operator.getitem(request, this.#publicRequest);
    } finally {
      request[Symbol.dispose]();
    }
  }

  settle(token: number, ok: boolean, value: PythonObject): void {
    const call = this.#module._calls.pop(token, null);
    if (call === null) return;
    try {
      const future = call[0];
      try {
        if (!future.set_running_or_notify_cancel()) return;
        if (ok) future.set_result(value);
        else future.set_exception(value);
      } finally {
        future[Symbol.dispose]();
      }
    } finally {
      call[Symbol.dispose]();
    }
  }

  get calls(): number {
    return this.#builtins.len(this.#module._calls) + this.#builtins.len(this.#module._requests);
  }

  shutdown(): PythonObject | null {
    const m = this.#module;
    const installed = this.#sys.modules.get("_node_ctypes", null);
    if (installed !== null && this.#builtins.id(installed) === this.#builtins.id(m)) this.#sys.modules.pop("_node_ctypes");
    m._lock.acquire();
    try {
      m._closing = true;
      m._notify = null;
      m._queued.clear();
    } finally {
      m._lock.release();
    }
    const pending: PythonObject[] = [];
    for (const request of m._requests.values()) {
      try {
        pending.push(request[3]);
      } finally {
        request[Symbol.dispose]();
      }
    }
    for (const call of m._calls.values()) {
      try {
        pending.push(call[0]);
      } finally {
        call[Symbol.dispose]();
      }
    }
    m._requests.clear();
    m._calls.clear();
    try {
      for (const future of pending) {
        if (future.set_running_or_notify_cancel()) future.set_exception(this.#builtins.RuntimeError("Node.js is exiting: the JavaScript function was not called"));
      }
      if (m._loop === null || !m._loop.is_running()) return null;
      return m._shutdown_loop;
    } finally {
      for (const future of pending) future[Symbol.dispose]();
      m._events.put(null);
    }
  }
}
