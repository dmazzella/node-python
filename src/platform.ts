// Copyright (c) 2026 Damiano Mazzella. MIT License (see LICENSE).
import { definePython } from "./bootstrap.ts";
import { PythonError, kwargs } from "./values.ts";
import type { InternalPythonObject as PythonObject } from "./types.ts";

const PLATFORM_ADAPTERS = `
class JsStream(io.TextIOBase):
    encoding = "utf-8"
    errors = "strict"
    def __init__(self, name, write):
        self.name, self._write = name, write
    def writable(self): return True
    def write(self, text):
        if not isinstance(text, str):
            raise TypeError(f"write() argument must be str, not {type(text).__name__}")
        if text: self._write(text)
        return len(text)

`;

export class PythonPlatform {
  #module: PythonObject;
  #sys: PythonObject;

  constructor(builtins: PythonObject, importModule: (name: string) => PythonObject, module: PythonObject) {
    this.#module = module;
    this.#sys = importModule("sys");
    module.io = importModule("io");
    definePython(builtins, module, PLATFORM_ADAPTERS, "<node-python stream and timer adapters>");
    for (const stream of [this.#sys.stdout, this.#sys.stderr]) {
      try {
        stream.reconfigure(kwargs({ encoding: "utf-8", line_buffering: true }));
      } catch (error) {
        if (!(error instanceof PythonError) || !["AttributeError", "OSError", "UnsupportedOperation"].includes(error.type)) throw error;
        error.exception[Symbol.dispose]();
      }
    }
  }

  redirect(name: "stdout" | "stderr", write: (text: string) => void): void {
    this.#sys[name] = this.#module.JsStream(`<node ${name}>`, write);
  }
}
