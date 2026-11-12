// Copyright (c) 2026 Damiano Mazzella. MIT License (see LICENSE).
import { definePython } from "./bootstrap.ts";
import { PythonError, kwargs } from "./values.ts";
import type { InternalPythonObject as PythonObject } from "./types.ts";

const PLATFORM_ADAPTERS = `
class JsStream(io.TextIOBase):
    encoding = "utf-8"
    errors = "strict"
    def __init__(self, name, write, flush=None):
        self.name, self._write, self._flush = name, write, flush
    def writable(self): return True
    def flush(self):
        if self._flush is not None: self._flush()
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
      // None without a console (an Electron renderer, a packaged GUI app on Windows).
      if (stream === null) continue;
      try {
        stream.reconfigure(kwargs({ encoding: "utf-8", line_buffering: true }));
      } catch (error) {
        if (!(error instanceof PythonError) || !["AttributeError", "OSError", "UnsupportedOperation"].includes(error.type)) throw error;
        error.exception[Symbol.dispose]();
      }
    }
  }

  redirect(name: "stdout" | "stderr", write: (text: string) => void, flush?: () => void): void {
    this.#sys[name] = this.#module.JsStream(`<node ${name}>`, write, flush ?? null);
  }
}

/**
 * Whole lines for `emit` (e.g. console.log) from text written in pieces:
 * `print("a", "b")` writes "a", " ", "b", "\n". A line without its newline
 * is emitted by `flush` (Python's flush(), and the flush at finalization).
 */
export function lineWriter(emit: (line: string) => void): { write: (text: string) => void; flush: () => void } {
  let pending = "";
  return {
    write(text) {
      const lines = (pending + text).split("\n");
      pending = lines.pop()!;
      for (const line of lines) emit(line);
    },
    flush() {
      if (!pending) return;
      const line = pending;
      pending = "";
      emit(line);
    },
  };
}
