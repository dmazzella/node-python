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
  #isawaitable: PythonObject;
  #isinstance: PythonObject;
  #hasattr: PythonObject;
  #getattr: PythonObject;
  #typeFn: PythonObject;
  #aiter: PythonObject;
  #len: PythonObject;
  #getitem: PythonObject;
  #eq: PythonObject;
  #partial: PythonObject;
  #futureType: PythonObject;
  #runCoroutineThreadsafe: PythonObject;
  #awaitHelper: PythonObject;
  #completedHelper: PythonObject;
  #anextHelper: PythonObject;
  #requests: PythonObject;
  #calls: PythonObject;
  #lockAcquire: PythonObject;
  #lockRelease: PythonObject;
  #sys: PythonObject;
  #publicRequest: PythonObject;
  #heldRequest: PythonObject;
  #raiseException: (exception: PythonObject) => never;

  constructor(builtins: PythonObject, importModule: (name: string) => PythonObject, module: PythonObject, busyAddress: bigint, raiseException: (exception: PythonObject) => never, wakeup = false) {
    this.#builtins = builtins;
    this.#module = module;
    using inspect = importModule("inspect");
    this.#isawaitable = inspect.isawaitable;
    this.#isinstance = builtins.isinstance;
    this.#hasattr = builtins.hasattr;
    this.#getattr = builtins.getattr;
    this.#typeFn = builtins.type;
    this.#aiter = builtins.aiter;
    this.#len = builtins.len;
    using operator = importModule("operator");
    this.#getitem = operator.getitem;
    this.#eq = operator.eq;
    using functools = importModule("functools");
    this.#partial = functools.partial;
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
    })) {
      using imported = importModule(library);
      module[name] = imported;
    }
    using threadingMod = module.threading;
    using lock = threadingMod.Lock();
    module._lock = lock;
    this.#lockAcquire = lock.acquire;
    this.#lockRelease = lock.release;
    using queueMod = importModule("queue");
    using events = queueMod.SimpleQueue();
    module._events = events;
    using queued = builtins.list();
    module._queued = queued;
    this.#requests = builtins.dict();
    module._requests = this.#requests;
    this.#calls = builtins.dict();
    module._calls = this.#calls;
    using itertools = importModule("itertools");
    using tokens = itertools.count(1);
    module._tokens = tokens;
    module._closing = false;
    module._loop = null;
    module._loop_error = null;
    module._notify = null;
    module._wakeup = null;
    module._interrupt_event = null;
    using nativeDispatchers = builtins.dict();
    module._native_dispatchers = nativeDispatchers;
    module._drains = 0;
    using ctypesMod = module.ctypes;
    using c_int = ctypesMod.c_int;
    using c_void_p = ctypesMod.c_void_p;
    using mainBusy = c_int.from_address(busyAddress);
    module._main_busy = mainBusy;
    using notifyType = ctypesMod.CFUNCTYPE(null, c_int, c_int);
    module._NOTIFY = notifyType;
    using nativeNotifyType = ctypesMod.CFUNCTYPE(null);
    module._NATIVE_NOTIFY = nativeNotifyType;
    using pendingType = ctypesMod.CFUNCTYPE(c_int, c_void_p);
    module._PENDING = pendingType;
    using pythonapi = ctypesMod.pythonapi;
    using addPending = pythonapi.Py_AddPendingCall;
    addPending.argtypes = Tuple.of(pendingType, c_void_p);
    module._add_pending_call = addPending;
    definePython(builtins, module, THREAD_ADAPTERS, "<node-python thread adapters>");
    using servePending = module._serve_pending;
    using servePendingC = pendingType(servePending);
    module._serve_pending_c = servePendingC;
    using futuresMod = module.concurrent_futures;
    this.#futureType = futuresMod.Future;
    using asyncioMod = module.asyncio;
    this.#runCoroutineThreadsafe = asyncioMod.run_coroutine_threadsafe;
    this.#awaitHelper = module._await;
    this.#completedHelper = module._completed;
    this.#anextHelper = module._anext;
    if (wakeup) this.#installWakeup();
  }

  #installWakeup(): void {
    const m = this.#module;
    if (this.#sys.platform === "win32") {
      using versionInfo = this.#sys.version_info;
      if (versionInfo[0] > 3 || versionInfo[1] >= 14) {
        try {
          using ctypesMod = m.ctypes;
          using pythonapi = ctypesMod.pythonapi;
          using event = pythonapi._PyOS_SigintEvent;
          using cVoidP = ctypesMod.c_void_p;
          event.restype = cVoidP;
          m._interrupt_event = event();
          using kernel32 = ctypesMod.WinDLL("kernel32");
          using setEvent = kernel32.SetEvent;
          using resetEvent = kernel32.ResetEvent;
          setEvent.argtypes = resetEvent.argtypes = Tuple.of(cVoidP);
          m._kernel32 = kernel32;
        } catch (error) {
          if (!(error instanceof PythonError) || !["AttributeError", "OSError"].includes(error.type)) throw error;
          error.exception[Symbol.dispose]();
          m._interrupt_event = null;
        }
      }
      return;
    }
    using sig = m.signal;
    if (!this.#hasattr(sig, "pthread_kill") || !this.#hasattr(sig, "SIGURG")) return;
    using current = sig.getsignal(sig.SIGURG);
    using sigDfl = sig.SIG_DFL;
    using sigIgn = sig.SIG_IGN;
    if (current !== null && !this.#eq(current, sigDfl) && !this.#eq(current, sigIgn)) return;
    using serveWaiting = m._serve_waiting;
    sig.signal(sig.SIGURG, serveWaiting);
    m._wakeup = sig.SIGURG;
  }

  isAwaitable(object: PythonObject): boolean {
    return this.#isawaitable(object) || this.#isinstance(object, this.#futureType);
  }

  isAsyncIterable(object: PythonObject): boolean {
    using type = this.#typeFn(object);
    return this.#hasattr(type, "__aiter__");
  }

  asyncIterator(object: PythonObject): PythonObject {
    return this.#aiter(object);
  }

  next(iterator: PythonObject): PythonObject {
    return this.#anextHelper(iterator);
  }

  closeIterator(iterator: PythonObject): unknown {
    using close = this.#getattr(iterator, "aclose", null);
    return close === null ? null : close();
  }

  #startLoop(): void {
    const m = this.#module;
    this.#lockAcquire();
    try {
      using existing = m._loop;
      if (existing !== null) return;
      using asyncioMod = m.asyncio;
      using loop = asyncioMod.new_event_loop();
      m._loop = loop;
      m._loop_error = null;
    } finally {
      this.#lockRelease();
    }
    using threadingMod = m.threading;
    using ready = threadingMod.Event();
    using runLoop = m._run_loop;
    using thread = threadingMod.Thread(kwargs({ target: runLoop, args: Tuple.of(ready), name: "asyncio", daemon: true }));
    thread.start();
    ready.wait();
    if (m._loop_error !== null) {
      const error: PythonObject = m._loop_error;
      m._loop_error = null;
      using loop = m._loop;
      loop.close();
      m._loop = null;
      this.#raiseException(error);
    }
  }

  submit(awaitable: PythonObject, token: number): PythonObject {
    const m = this.#module;
    let future: PythonObject;
    if (this.#isinstance(awaitable, this.#futureType)) future = awaitable;
    else {
      this.#startLoop();
      using coroutine = this.#awaitHelper(awaitable);
      using loop = m._loop;
      future = this.#runCoroutineThreadsafe(coroutine, loop);
    }
    using complete = this.#partial(this.#completedHelper, token);
    using addDone = future.add_done_callback;
    addDone(complete);
    return future;
  }

  openChannel(address: bigint): void {
    const m = this.#module;
    using threadingMod = m.threading;
    using notifier = m._notifier;
    using thread = threadingMod.Thread(kwargs({ target: notifier, name: "node-ctypes-notifier", daemon: true }));
    thread.start();
    this.#lockAcquire();
    try {
      using notifyType = m._NOTIFY;
      using notify = notifyType(address);
      m._notify = notify;
      using queued = m._queued;
      using events = m._events;
      for (const event of queued) {
        try {
          events.put(Tuple.of(notify, ...event));
        } finally {
          if (event !== null && (typeof event === "object" || typeof event === "function") && Symbol.dispose in event) (event as Disposable)[Symbol.dispose]();
        }
      }
      queued.clear();
    } finally {
      this.#lockRelease();
    }
  }

  takeRequest(token: number): PythonObject | null {
    using pop = this.#requests.pop;
    const request = pop(token, null);
    if (request === null) return null;
    try {
      using future = request[3];
      using cancelled = future.cancelled;
      if (cancelled()) return null;
      using held = this.#getitem(request, this.#heldRequest);
      this.#calls[token] = held;
      return this.#getitem(request, this.#publicRequest);
    } finally {
      request[Symbol.dispose]();
    }
  }

  settle(token: number, ok: boolean, value: PythonObject): void {
    using pop = this.#calls.pop;
    using call = pop(token, null);
    if (call === null) return;
    using future = call[0];
    using setRunning = future.set_running_or_notify_cancel;
    if (!setRunning()) return;
    if (ok) {
      using setResult = future.set_result;
      setResult(value);
    } else {
      using setException = future.set_exception;
      setException(value);
    }
  }

  get calls(): number {
    return this.#len(this.#calls) + this.#len(this.#requests);
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
