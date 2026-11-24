// Copyright (c) 2026 Damiano Mazzella. MIT License (see LICENSE).
import { Tuple } from "./values.ts";
import type { InternalPythonObject as PythonObject } from "./types.ts";

export function definePython(builtins: PythonObject, module: PythonObject, source: string, filename: string): void {
  const code = builtins.compile(source, filename, "exec");
  const namespace = module.__dict__;
  try {
    builtins.exec(code, namespace);
  } finally {
    namespace[Symbol.dispose]();
    code[Symbol.dispose]();
  }
}

const CALLABLE = `
def wrap(cfunc, fid):
    name = cfunc.__name__
    def javascript(*args, **kwargs):
        if threading.get_ident() == _main or threading.get_ident() == _execution[0]:
            return cfunc(*args, **kwargs)
        return _call_later(fid, args, kwargs, javascript)
    javascript.__name__ = javascript.__qualname__ = name
    javascript.__doc__ = f"JavaScript function {name}"
    javascript._node_ctypes_id = fid
    javascript.new = lambda *args, **kwargs: _js("new", javascript, *args, **kwargs)
    weakref.finalize(javascript, _released.append, fid)
    return javascript

def _js(op, *args, **kwargs):
    if threading.get_ident() == _main:
        return _op(op, *args, **kwargs)
    return _call_later(_op._node_ctypes_id, (op,) + args, kwargs, _op, awaitable=False).result()

`;

export class PythonBootstrap {
  readonly module: PythonObject;
  readonly wrap: PythonObject;
  readonly objectType: PythonObject;
  readonly javascriptCode: PythonObject;
  readonly mainThread: number | bigint;

  constructor(builtins: PythonObject, importModule: (name: string) => PythonObject) {
    using types = importModule("types");
    using collections = importModule("collections");
    const module = (this.module = types.ModuleType("_node_ctypes"));
    using threading = importModule("threading");
    using weakref = importModule("weakref");
    module.threading = threading;
    module.weakref = weakref;
    module._main = this.mainThread = threading.get_ident();
    using execution = builtins.list([null]);
    module._execution = execution;
    using deque = collections.deque;
    using released = deque();
    module._released = released;
    module._op = null;
    definePython(builtins, module, CALLABLE, "<node-python callables>");
    this.wrap = module.wrap;
    using wrapCode = this.wrap.__code__;
    using consts = wrapCode.co_consts;
    let javascriptCode: PythonObject | undefined;
    for (const value of consts) {
      if (javascriptCode === undefined && typeof value === "function" && builtins.getattr(value, "co_name", null) === "javascript") {
        javascriptCode = value;
      } else if (value !== null && (typeof value === "object" || typeof value === "function") && Symbol.dispose in value) {
        (value as Disposable)[Symbol.dispose]();
      }
    }
    if (!javascriptCode) throw new Error("Python callable adapter has no javascript code object");
    this.javascriptCode = javascriptCode;
    module.JAVASCRIPT_CODE = this.javascriptCode;
    using jsProxy = builtins.type("JsProxy", Tuple.of(builtins.object), {
      __module__: "_node_ctypes",
      __slots__: Tuple.of("_id", "__weakref__"),
      __doc__: "A JavaScript object used by reference: attributes, items, len(),\n    iteration (also async for), await (promises), dir(), repr().",
    });
    module.JsProxy = jsProxy;
    using asyncIter = builtins.type("_JsAsyncIterator", Tuple.of(builtins.object), { __module__: "_node_ctypes" });
    module._JsAsyncIterator = asyncIter;
    this.objectType = module.JsProxy;
  }
}
