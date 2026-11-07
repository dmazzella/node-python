// Copyright (c) 2026 Damiano Mazzella. MIT License (see LICENSE).
import type { PythonObject } from "./types.ts";
/** A Python exception raised in JavaScript. */
export class PythonError extends Error {
  type: string;
  declare traceback: string;
  declare exception: PythonObject;
  /**
   * @param {string} type - Exception class name (e.g. "ZeroDivisionError")
   * @param {string} message - str(exception)
   * @param {string} traceback - Formatted Python traceback
   * @param {*} exception - The exception object (PyObject proxy)
   */
  constructor(type: string, message: string, traceback: string, exception: PythonObject) {
    super(message ? `${type}: ${message}` : type);
    this.name = "PythonError";
    this.type = type;
    Object.defineProperties(this, {
      traceback: { value: traceback, writable: true, configurable: true },
      exception: { value: exception, writable: true, configurable: true },
    });
    if (traceback) this.stack += `\n\nPython ${traceback.trimEnd()}`;
  }
}

/**
 * A Python tuple in JavaScript: tuples converted deeply (`eval()`, `toJS()`)
 * are Tuples, and Tuples are converted to tuples: `Tuple.of(1, 2)`.
 */
export class Tuple<T = unknown> extends Array<T> {
  static get [Symbol.species]() {
    return Array; // map(), filter(), ... return plain arrays
  }
}

export class ByReference<T = unknown> {
  value: T;
  constructor(value: T) {
    this.value = value;
  }
}

/**
 * Pass a JavaScript value to Python by reference instead of by value: objects
 * and arrays become a JsProxy (changes made by Python are seen by
 * JavaScript), a Uint8Array/Buffer a writable memoryview of its memory.
 * @param {Object} value
 */
export function byReference<T>(value: T): ByReference<T> {
  return new ByReference(value);
}

export const CANCELLABLE = Symbol("cancellable");

/**
 * Mark a JavaScript function as cancellable: it gets an AbortSignal as last
 * argument, aborted when Python cancels the call (e.g. the coroutine awaiting
 * it is cancelled, or asyncio.wait_for times out).
 * @param {Function} fn
 * @returns {Function} fn
 */
export function cancellable<T extends Function>(fn: T): T {
  Object.assign(fn, { [CANCELLABLE]: true });
  return fn;
}

// A JavaScript error raised in Python as a specific built-in exception.
export const PY_TYPE = Symbol("python exception type");
export const pythonError = (type: string, message: string) => Object.assign(new Error(message), { [PY_TYPE]: type });
export const isClass = (fn: Function) => /^class[\s{]/.test(Function.prototype.toString.call(fn));
export const typeName = (value: unknown) => value?.constructor?.name ?? typeof value;
// Typed array → memoryview format.
export const FORMATS: Readonly<Record<string, string>> = {
  Int8Array: "b",
  Uint8Array: "B",
  Uint8ClampedArray: "B",
  Int16Array: "h",
  Uint16Array: "H",
  Int32Array: "i",
  Uint32Array: "I",
  Float16Array: "e",
  Float32Array: "f",
  Float64Array: "d",
  BigInt64Array: "q",
  BigUint64Array: "Q",
};

export class Kwargs {
  values: Record<string, unknown>;
  constructor(values: Record<string, unknown>) {
    this.values = values;
  }
}

/**
 * Keyword arguments of a Python call, as its last argument:
 * `json.dumps(data, kwargs({ indent: 2 }))` is `json.dumps(data, indent=2)`.
 * @param {Object} values
 */
export function kwargs(values: Record<string, unknown>): Kwargs {
  return new Kwargs(values);
}
