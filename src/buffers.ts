// Copyright (c) 2026 Damiano Mazzella. MIT License (see LICENSE).
import type { InternalPythonObject as PythonObject } from "./types.ts";

const TYPED: Record<string, string> = {
  b: "Int8Array",
  B: "Uint8Array",
  h: "Int16Array",
  H: "Uint16Array",
  i: "Int32Array",
  I: "Uint32Array",
  q: "BigInt64Array",
  Q: "BigUint64Array",
  e: "Float16Array",
  f: "Float32Array",
  d: "Float64Array",
};
const SIZED: Record<string, string> = { l4: "i", l8: "q", L4: "I", L8: "Q", n4: "i", n8: "q", N4: "I", N8: "Q", P8: "Q", P4: "I" };

export class PythonBuffers {
  #memoryview: PythonObject;
  #bytearray: PythonObject;
  #cChar: PythonObject;
  #addressof: PythonObject;
  #mul: PythonObject;
  #byteorder: string;
  #bufferError: (message: string) => never;

  constructor(builtins: PythonObject, importModule: (name: string) => PythonObject, bufferError: (message: string) => never) {
    this.#memoryview = builtins.memoryview;
    this.#bytearray = builtins.bytearray;
    using ctypes = importModule("ctypes");
    this.#cChar = ctypes.c_char;
    this.#addressof = ctypes.addressof;
    using operator = importModule("operator");
    this.#mul = operator.mul;
    using sys = importModule("sys");
    this.#byteorder = sys.byteorder;
    this.#bufferError = bufferError;
  }

  memory(address: bigint, size: number, format: string, keep: PythonObject): PythonObject {
    const owner = size ? this.#mul(this.#cChar, size).from_address(address) : this.#bytearray();
    try {
      if (size) owner._node_ctypes_keep = keep;
      const view = this.#memoryview(owner);
      try {
        if (!size) return view.cast(format);
        const bytes = view.cast("B");
        try {
          return bytes.cast(format);
        } finally {
          bytes[Symbol.dispose]();
        }
      } finally {
        view[Symbol.dispose]();
      }
    } finally {
      owner[Symbol.dispose]();
    }
  }

  export(target: PythonObject): [string, PythonObject | null, bigint, number, Buffer | null] {
    const view = this.#memoryview(target);
    try {
      if (!view.c_contiguous) this.#bufferError("toTypedArray() needs a C-contiguous buffer");
      let format: string = view.format;
      if (["@", "=", this.#byteorder === "little" ? "<" : ">"].includes(format.slice(0, 1))) format = format.slice(1);
      format = SIZED[`${format}${view.itemsize}`] ?? format;
      const name = TYPED[format] ?? "Uint8Array";
      const size: number = view.nbytes;
      if (view.readonly) return [name, null, 0n, size, view.tobytes()];
      if (!size) return [name, null, 0n, 0, null];
      const bytes = view.format === "B" ? null : view.cast("B");
      try {
        using arrayType = this.#mul(this.#cChar, size);
        const holder: PythonObject = arrayType.from_buffer(bytes ?? view);
        return [name, holder, BigInt(this.#addressof(holder)), size, null];
      } finally {
        bytes?.[Symbol.dispose]();
      }
    } finally {
      view[Symbol.dispose]();
    }
  }
}
