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
    const module = (this.module = importModule("types").ModuleType("_node_ctypes"));
    module.threading = importModule("threading");
    module.weakref = importModule("weakref");
    module._main = this.mainThread = module.threading.get_ident();
    module._execution = builtins.list([null]);
    const deque = importModule("collections").deque;
    module._released = deque();
    module._op = null;
    definePython(builtins, module, CALLABLE, "<node-python callables>");
    this.wrap = module.wrap;
    this.javascriptCode = [...this.wrap.__code__.co_consts].find((value) => typeof value === "function" && builtins.getattr(value, "co_name", null) === "javascript");
    if (!this.javascriptCode) throw new Error("Python callable adapter has no javascript code object");
    module.JAVASCRIPT_CODE = this.javascriptCode;
    module.JsProxy = builtins.type("JsProxy", Tuple.of(builtins.object), {
      __module__: "_node_ctypes",
      __slots__: Tuple.of("_id", "__weakref__"),
      __doc__: "A JavaScript object used by reference: attributes, items, len(),\n    iteration (also async for), await (promises), dir(), repr().",
    });
    module._JsAsyncIterator = builtins.type("_JsAsyncIterator", Tuple.of(builtins.object), { __module__: "_node_ctypes" });
    this.objectType = module.JsProxy;
  }
}
