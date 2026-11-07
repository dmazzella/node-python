// Copyright (c) 2026 Damiano Mazzella. MIT License (see LICENSE).
import { addressof, array, c_int, c_ssize_t, c_uint8, c_void_p, threadSafeCallback } from "node-ctypes";
import { METH_KEYWORDS, METH_NOARGS, METH_VARARGS, PyCFunctionMethodDef, PyMethodDef, PyTypeSlot, PyTypeSpec, Py_file_input } from "./native.ts";
import type { PythonLibrary } from "./native.ts";

type Pointer = bigint | null;
type Result = bigint | number | null;

const PROTOCOLS = `
import asyncio as _asyncio

def _future(operation, obj):
    future = _enqueue(operation, obj)
    try:
        return _asyncio.wrap_future(future, loop=_asyncio.get_running_loop())
    except RuntimeError:
        return future

def iterate(self):
    iterator = _operate("iter", self)
    while True:
        done, value = _operate("next", iterator)
        if done:
            return
        yield value

async def async_next(self):
    done, value = await _future("anext", self.iterator)
    if done:
        raise StopAsyncIteration
    return value

def await_value(self):
    return _future("await", self).__await__()
`;

export interface NativeSlot {
  readonly pointer: bigint;
  release(): void;
  unref(): unknown;
  setNativeError(error: bigint): void;
  drain(): number;
}

function isNativeSlot(value: unknown): value is NativeSlot {
  if (typeof value !== "object" || value === null) return false;
  return (
    "pointer" in value &&
    typeof value.pointer === "bigint" &&
    "release" in value &&
    typeof value.release === "function" &&
    "unref" in value &&
    typeof value.unref === "function" &&
    "setNativeError" in value &&
    typeof value.setNativeError === "function" &&
    "drain" in value &&
    typeof value.drain === "function" &&
    "_callback" in value &&
    typeof value._callback === "object" &&
    value._callback !== null &&
    "setNativeError" in value._callback &&
    typeof value._callback.setNativeError === "function" &&
    "drain" in value._callback &&
    typeof value._callback.drain === "function"
  );
}

export function nativeSlot(api: PythonLibrary, handler: (...args: unknown[]) => unknown, restype: typeof c_void_p | typeof c_ssize_t | typeof c_int | null, argtypes: (typeof c_void_p | typeof c_int)[], notify?: bigint): NativeSlot {
  // Reflect keeps the standalone project type-compatible with the published core.
  const created: unknown = Reflect.apply(threadSafeCallback, undefined, [
    handler,
    restype,
    argtypes,
    {
      nativeContext: {
        suspend: api.PyEval_SaveThread,
        resume: api.PyEval_RestoreThread,
        onError: api.PyErr_SetRaisedException,
        ...(notify === undefined ? {} : { notify }),
      },
    },
  ]);
  if (!isNativeSlot(created)) {
    if (typeof created === "object" && created !== null && "release" in created && typeof created.release === "function") created.release();
    throw new Error("node-python requires node-ctypes 2.6.0+ with native callback contexts and drain()");
  }
  created.unref();
  return created;
}

function pointer(value: unknown): Pointer {
  if (value === null || typeof value === "bigint") return value;
  throw new TypeError("Expected a native Python object pointer");
}

interface ObjectRuntime {
  withGIL<T>(fn: () => T): T;
  check(value: Pointer): bigint;
  fromPython(value: Pointer): unknown;
  toPython(value: unknown): bigint;
  operate(op: string, self: Pointer, args: Pointer[], kwargs?: Pointer): unknown;
  raise(error: unknown): void;
}

interface ObjectProtocols {
  asyncIterator: bigint;
  callLater: bigint;
  operation: bigint;
  wrap: bigint;
}

/** Slots own no instance references: the Python base retains its GC/weakref lifecycle. */
export class NativeObjects {
  readonly type: bigint;
  #api: PythonLibrary;
  #runtime: ObjectRuntime;
  #callbacks: NativeSlot[] = [];
  #keep: object[] = [];
  #owned: bigint[] = [];
  #ownsType = true;
  #wrapCallable!: (callable: bigint, id: bigint) => bigint;
  #track!: (instance: bigint, id: bigint) => void;
  #drainReleased!: (forgetFunction: (id: bigint) => void, forgetObject: (id: bigint) => void) => void;

  constructor(api: PythonLibrary, base: bigint, runtime: ObjectRuntime, protocols: ObjectProtocols, notify?: bigint) {
    this.#api = api;
    this.#runtime = runtime;
    try {
      const attributeError = runtime.check(c_void_p.in_dll(api, "PyExc_AttributeError").value);
      const overflowError = runtime.check(c_void_p.in_dll(api, "PyExc_OverflowError").value);
      const valueError = runtime.check(c_void_p.in_dll(api, "PyExc_ValueError").value);
      const notImplemented = addressof(c_uint8.in_dll(api, "_Py_NotImplementedStruct"));
      const typeError = runtime.check(c_void_p.in_dll(api, "PyExc_TypeError").value);
      const own = (value: Pointer) => {
        const owned = runtime.check(value);
        this.#owned.push(owned);
        return owned;
      };
      const using = <T>(value: Pointer, fn: (value: bigint) => T): T => {
        const owned = runtime.check(value);
        try {
          return fn(owned);
        } finally {
          api.Py_DecRef(owned);
        }
      };
      const tuple = (values: Pointer[]) => {
        const result = runtime.check(api.PyTuple_New(values.length));
        try {
          values.forEach((value, index) => {
            api.Py_IncRef(value);
            if (api.PyTuple_SetItem(result, index, value) < 0) runtime.check(null);
          });
          return result;
        } catch (error) {
          api.Py_DecRef(result);
          throw error;
        }
      };
      const call = (callable: Pointer, args: Pointer[]) => using(tuple(args), (args) => runtime.check(api.PyObject_Call(callable, args, null)));
      const heapType = (name: string, parent: bigint, entries: Array<[number, bigint]>) => {
        const slots = array(PyTypeSlot, entries.length + 1)();
        entries.forEach(([id, address], index) => {
          slots[index] = new PyTypeSlot(id, address);
        });
        const spec = new PyTypeSpec(name, 0, 0, 1 << 7, addressof(slots));
        this.#keep.push(slots, spec);
        return using(tuple([parent]), (bases) => own(api.PyType_FromSpecWithBases(spec._buffer, bases)));
      };
      const specs: Array<[number, bigint]> = [];
      const createCallback = (restype: typeof c_void_p | typeof c_ssize_t | typeof c_int, argtypes: (typeof c_void_p | typeof c_int)[], fn: (...args: unknown[]) => Result, sentinel: Result) => {
        let callback: NativeSlot;
        callback = nativeSlot(
          api,
          (...args) =>
            runtime.withGIL(() => {
              let result: Result;
              try {
                result = fn(...args);
              } catch (error) {
                runtime.raise(error);
                result = sentinel;
              }
              const error = api.PyErr_GetRaisedException();
              if (error) {
                try {
                  callback.setNativeError(error);
                } catch (transferError) {
                  api.Py_DecRef(error);
                  throw transferError;
                }
                return sentinel;
              }
              return result;
            }),
          restype,
          argtypes,
          notify,
        );
        this.#callbacks.push(callback);
        return callback;
      };
      const slot = (id: number, restype: typeof c_void_p | typeof c_ssize_t | typeof c_int, nargs: number, fn: (...args: Pointer[]) => Result, sentinel: Result) => {
        const callback = createCallback(
          restype,
          Array.from({ length: nargs }, () => c_void_p),
          (...args) => fn(...args.map(pointer)),
          sentinel,
        );
        specs.push([id, callback.pointer]);
        return callback;
      };
      const object = (op: string, self: Pointer, args: Pointer[] = [], kwargs?: Pointer) => runtime.toPython(runtime.operate(op, self, args, kwargs));
      const builtin = (name: string, callback: NativeSlot, context: Pointer = null) => {
        const method = new PyCFunctionMethodDef(name, callback.pointer, METH_VARARGS, null);
        this.#keep.push(method);
        return runtime.check(api.PyCFunction_NewEx(method._buffer, context, null));
      };
      const namespace = own(api.PyDict_New());
      const put = (name: string, value: Pointer) => {
        if (api.PyDict_SetItemString(namespace, name, value) < 0) runtime.check(null);
      };
      put("__builtins__", api.PyEval_GetBuiltins());
      using(runtime.toPython("_node_ctypes_native"), (name) => put("__name__", name));
      const operate = (values: Pointer, kwargs?: Pointer) => {
        const size = Number(api.PyTuple_Size(values));
        if (size < 2) {
          api.PyErr_SetString(typeError, "Native object dispatch requires an operation and object");
          return null;
        }
        const op = runtime.fromPython(api.PyTuple_GetItem(values, 0));
        if (typeof op !== "string") throw new TypeError("Expected a native object operation name");
        return object(
          op,
          api.PyTuple_GetItem(values, 1),
          Array.from({ length: size - 2 }, (_, index) => api.PyTuple_GetItem(values, index + 2)),
          kwargs,
        );
      };
      const dispatch = createCallback(c_void_p, [c_void_p, c_void_p], (_context, args) => operate(pointer(args)), null);
      using(builtin("_operate", dispatch), (dispatch) => put("_operate", dispatch));
      const construct = createCallback(c_void_p, [c_void_p, c_void_p, c_void_p], (_context, args, kwargs) => operate(pointer(args), pointer(kwargs)), null);
      const constructMethod = new PyMethodDef("_js", construct.pointer, METH_VARARGS | METH_KEYWORDS, null);
      this.#keep.push(constructMethod);
      const callableGlobals = own(api.PyDict_New());
      const setCallableGlobal = (name: string, value: Pointer) => {
        if (api.PyDict_SetItemString(callableGlobals, name, value) < 0) runtime.check(null);
      };
      const queues = using(api.PyImport_ImportModule("collections"), (module) =>
        using(api.PyObject_GetAttrString(module, "deque"), (deque) => ({
          functions: own(call(deque, [])),
          objects: own(call(deque, [])),
        })),
      );
      const releaseQueue = (queue: bigint) => {
        const pop = own(api.PyObject_GetAttrString(queue, "popleft"));
        return (forget: (id: bigint) => void) => {
          for (;;) {
            const pending = api.PyObject_IsTrue(queue);
            if (pending < 0) runtime.check(null);
            if (!pending) return;
            using(call(pop, []), (value) => {
              const id = runtime.fromPython(value);
              if (typeof id !== "bigint" && (typeof id !== "number" || !Number.isSafeInteger(id))) throw new TypeError("Invalid native release identifier");
              forget(BigInt(id));
            });
          }
        };
      };
      using(api.PyObject_GetAttrString(protocols.wrap, "__globals__"), (globals) => {
        for (const name of ["__name__", "__builtins__", "threading", "_main", "_execution", "_call_later", "weakref"]) {
          setCallableGlobal(name, runtime.check(api.PyDict_GetItemString(globals, name)));
        }
        const bootstrapFunctions = releaseQueue(runtime.check(api.PyDict_GetItemString(globals, "_released")));
        const drainFunctions = releaseQueue(queues.functions);
        const drainObjects = releaseQueue(queues.objects);
        this.#drainReleased = (forgetFunction, forgetObject) => {
          bootstrapFunctions(forgetFunction);
          drainFunctions(forgetFunction);
          drainObjects(forgetObject);
        };
      });
      setCallableGlobal("_released", queues.functions);
      const finalize = own(api.PyObject_GetAttrString(runtime.check(api.PyDict_GetItemString(callableGlobals, "weakref")), "finalize"));
      const appendObject = own(api.PyObject_GetAttrString(queues.objects, "append"));
      this.#track = (instance, id) => {
        using(call(finalize, [instance, appendObject, id]), () => {});
      };
      using(api.PyCFunction_NewEx(constructMethod._buffer, null, null), (construct) => setCallableGlobal("_js", construct));
      using(api.PyObject_GetAttrString(protocols.wrap, "__code__"), (code) => {
        using(api.PyObject_Type(protocols.wrap), (functionType) => {
          const factory = own(call(functionType, [code, callableGlobals]));
          this.#wrapCallable = (callable, id) => using(runtime.toPython(id), (id) => call(factory, [callable, id]));
        });
      });
      const enqueue = createCallback(
        c_void_p,
        [c_void_p, c_void_p],
        (context, args) => {
          const values = pointer(args);
          if (api.PyTuple_Size(values) !== 2n) {
            api.PyErr_SetString(typeError, "Native async dispatch requires an operation and object");
            return null;
          }
          const payload = pointer(context);
          const callLater = api.PyTuple_GetItem(payload, 0);
          const operation = api.PyTuple_GetItem(payload, 1);
          const id = api.PyTuple_GetItem(payload, 2);
          // Wrap the concurrent future on the original Python thread, not Node's thread.
          return using(api.PyDict_New(), (kwargs) => using(api.PyBool_FromLong(0), (awaitable) => call(callLater, [id, values, kwargs, operation, awaitable])));
        },
        null,
      );
      using(api.PyObject_GetAttrString(protocols.operation, "_node_ctypes_id"), (id) => {
        using(tuple([protocols.callLater, protocols.operation, id]), (context) => {
          using(builtin("_enqueue", enqueue, context), (enqueue) => put("_enqueue", enqueue));
        });
      });
      using(api.Py_CompileString(PROTOCOLS, "<node-python native protocols>", Py_file_input), (code) => {
        using(api.PyEval_EvalCode(code, namespace, namespace), () => {});
      });
      const iteratorFactory = runtime.check(api.PyDict_GetItemString(namespace, "iterate"));
      const asyncNext = runtime.check(api.PyDict_GetItemString(namespace, "async_next"));
      const awaitValue = runtime.check(api.PyDict_GetItemString(namespace, "await_value"));
      const asyncSelf = createCallback(
        c_void_p,
        [c_void_p],
        (self) => {
          const value = pointer(self);
          api.Py_IncRef(value);
          return value;
        },
        null,
      );
      const asyncType = heapType("_node_ctypes.JsAsyncIterator", protocols.asyncIterator, [[78, asyncSelf.pointer]]);
      if (api.PyObject_SetAttrString(asyncType, "__anext__", asyncNext) < 0) runtime.check(null);
      slot(
        58,
        c_void_p,
        2,
        (self, name) => {
          const found = api.PyObject_GenericGetAttr(self, name);
          if (found || !api.PyErr_ExceptionMatches(attributeError)) return found;
          api.PyErr_Clear();
          const text = runtime.fromPython(name);
          if (typeof text !== "string") throw new TypeError("Expected a Python attribute name");
          if (text.startsWith("__") && text.endsWith("__")) {
            api.PyErr_SetString(attributeError, text);
            return null;
          }
          return object("getattr", self, [name]);
        },
        null,
      );
      slot(
        69,
        c_int,
        3,
        (self, name, value) => {
          runtime.operate(value === null ? "delattr" : "setattr", self, value === null ? [name] : [name, value]);
          return 0;
        },
        -1,
      );
      slot(5, c_void_p, 2, (self, key) => object("getitem", self, [key]), null);
      slot(
        3,
        c_int,
        3,
        (self, key, value) => {
          runtime.operate(value === null ? "delitem" : "setitem", self, value === null ? [key] : [key, value]);
          return 0;
        },
        -1,
      );
      const length = slot(
        45,
        c_ssize_t,
        1,
        (self) => {
          const value = object("len", self);
          let size: bigint;
          try {
            size = api.PyNumber_AsSsize_t(value, overflowError);
          } finally {
            api.Py_DecRef(value);
          }
          if (size < 0n && !api.PyErr_Occurred()) api.PyErr_SetString(valueError, "__len__() should return >= 0");
          return size;
        },
        -1n,
      );
      specs.push([4, length.pointer]);
      slot(9, c_int, 1, (self) => Number(Boolean(runtime.operate("bool", self, []))), -1);
      slot(41, c_int, 2, (self, value) => Number(Boolean(runtime.operate("contains", self, [value]))), -1);
      slot(66, c_void_p, 1, (self) => object("repr", self), null);
      slot(70, c_void_p, 1, (self) => object("str", self), null);
      slot(
        62,
        c_void_p,
        1,
        (self) => {
          if (!this.#ownsType) throw new Error("Cannot create native iterators while Python is finalizing");
          return call(iteratorFactory, [self]);
        },
        null,
      );
      slot(
        78,
        c_void_p,
        1,
        (self) => {
          if (!this.#ownsType) throw new Error("Cannot create native iterators while Python is finalizing");
          return using(object("aiter", self), (iterator) => {
            const instance = runtime.check(api.PyType_GenericAlloc(asyncType, 0));
            try {
              using(runtime.toPython("iterator"), (name) => {
                if (api.PyObject_GenericSetAttr(instance, name, iterator) < 0) runtime.check(null);
              });
              return instance;
            } catch (error) {
              api.Py_DecRef(instance);
              throw error;
            }
          });
        },
        null,
      );
      slot(
        59,
        c_ssize_t,
        1,
        (self) => {
          const id = runtime.check(api.PyObject_GetAttrString(self, "_id"));
          try {
            return api.PyObject_Hash(id);
          } finally {
            api.Py_DecRef(id);
          }
        },
        -1n,
      );
      const compare = createCallback(
        c_void_p,
        [c_void_p, c_void_p, c_int],
        (left, right, operation) => {
          const self = pointer(left);
          const other = pointer(right);
          if (typeof operation !== "number") throw new TypeError("Expected a Python comparison opcode");
          if (operation !== 2 && operation !== 3) {
            api.Py_IncRef(notImplemented);
            return notImplemented;
          }
          const matches = api.PyObject_IsInstance(other, base);
          if (matches < 0) return null;
          if (!matches) return api.PyBool_FromLong(Number(operation === 3));
          const otherId = runtime.check(api.PyObject_GetAttrString(other, "_id"));
          let equal: Pointer;
          try {
            const selfId = runtime.check(api.PyObject_GetAttrString(self, "_id"));
            try {
              equal = api.PyObject_RichCompare(otherId, selfId, 2);
            } finally {
              api.Py_DecRef(selfId);
            }
          } finally {
            api.Py_DecRef(otherId);
          }
          if (!equal || operation === 2) return equal;
          try {
            // The base inherits object.__ne__: negate equality, not the IDs' __ne__.
            const truth = api.PyObject_IsTrue(equal);
            return truth < 0 ? null : api.PyBool_FromLong(Number(!truth));
          } finally {
            api.Py_DecRef(equal);
          }
        },
        null,
      );
      specs.push([67, compare.pointer]);
      const dir = createCallback(c_void_p, [c_void_p, c_void_p], (self) => object("dir", pointer(self)), null);
      const dirMethod = new PyCFunctionMethodDef("__dir__", dir.pointer, METH_NOARGS, null);
      const methods = array(PyCFunctionMethodDef, 2)();
      methods[0] = dirMethod;
      specs.push([64, addressof(methods)]);
      this.#keep.push(dirMethod, methods);
      this.type = heapType("_node_ctypes.JsProxy", base, specs);
      if (api.PyObject_SetAttrString(this.type, "__await__", awaitValue) < 0) runtime.check(null);
    } catch (error) {
      const errors = [error];
      try {
        this.releaseType();
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
      try {
        api.PyGC_Collect();
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
      try {
        this.releaseCallbacks();
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
      if (errors.length === 1) throw error;
      throw new AggregateError(errors, "Native Python object initialization failed");
    }
  }

  create(id: bigint): bigint {
    if (!this.#ownsType) throw new Error("Cannot create native shared objects while Python is finalizing");
    const api = this.#api;
    const instance = this.#runtime.check(api.PyType_GenericAlloc(this.type, 0));
    try {
      const name = this.#runtime.toPython("_id");
      try {
        if (api.PyObject_GenericSetAttr(instance, name, id) < 0) this.#runtime.check(null);
      } finally {
        api.Py_DecRef(name);
      }
      this.#track(instance, id);
      return instance;
    } catch (error) {
      api.Py_DecRef(instance);
      throw error;
    }
  }

  createCallable(callable: bigint, id: bigint): bigint {
    if (!this.#ownsType) throw new Error("Cannot create native callables while Python is finalizing");
    return this.#wrapCallable(callable, id);
  }

  drainReleased(forgetFunction: (id: bigint) => void, forgetObject: (id: bigint) => void): void {
    if (!this.#ownsType) throw new Error("Cannot drain native release queues while Python is finalizing");
    this.#drainReleased(forgetFunction, forgetObject);
  }

  drain(): void {
    for (const callback of this.#callbacks) callback.drain();
  }

  releaseType(): void {
    if (!this.#ownsType) return;
    this.#ownsType = false;
    const errors: unknown[] = [];
    for (const reference of this.#owned.splice(0).reverse()) {
      try {
        this.#api.Py_DecRef(reference);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Native Python object ownership release failed");
  }

  releaseCallbacks(): void {
    for (const callback of this.#callbacks) callback.release();
    this.#callbacks = [];
    this.#keep = [];
  }
}
