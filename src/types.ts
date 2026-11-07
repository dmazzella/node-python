// Copyright (c) 2026 Damiano Mazzella. MIT License (see LICENSE).

/** Python's arbitrary attribute/call surface is intentionally dynamic. */
export interface PythonObject extends Iterable<unknown>, AsyncIterable<unknown>, Disposable {
  [name: string]: any;
  [index: number]: any;
  (...args: unknown[]): Promise<any>;
  new (...args: unknown[]): Promise<PythonObject>;
  toJS<T = unknown>(): T;
  toJSON<T = unknown>(): T;
  toTypedArray(): PythonTypedArray;
  toString(): string;
}

/** Private service view: only bounded runtime housekeeping uses synchronous calls. */
export interface InternalPythonObject extends Iterable<unknown>, AsyncIterable<unknown>, Disposable {
  [name: string]: any;
  [index: number]: any;
  (...args: unknown[]): any;
  new (...args: unknown[]): InternalPythonObject;
  toJS<T = unknown>(): T;
  toJSON<T = unknown>(): T;
  toTypedArray(): PythonTypedArray;
  toString(): string;
}

export type PyObject = PythonObject;
// Resolves to never where the consumer's TypeScript lib lacks Float16Array.
type Float16ArrayIfAvailable = typeof globalThis extends { Float16Array: abstract new (...args: never) => infer T } ? T : never;
export type PythonTypedArray = Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array | Float16ArrayIfAvailable | Float32Array | Float64Array | BigInt64Array | BigUint64Array;

export type OutputTarget = "inherit" | "node" | ((text: string) => unknown);
export interface StreamOptions {
  stdin: boolean;
  stdout: OutputTarget;
  stderr: OutputTarget;
}
export interface PythonOptions extends Partial<StreamOptions> {
  executable?: string;
  library?: string;
  /** Serve native callbacks during interruptible synchronous Python waits. */
  synchronousCallbacks?: boolean;
  /**
   * GIL switch interval in milliseconds (sys.setswitchinterval), default 5 as
   * in CPython. While Python threads run CPU-bound code, the Node.js thread
   * waits for the GIL on every call: a smaller value (0.5) keeps the event loop
   * responsive at the cost of slower contended Python threads.
   */
  switchInterval?: number;
}
export interface RunOptions {
  signal?: AbortSignal;
}
export interface PythonStats {
  proxies: number;
  functions: number;
  objects: number;
  awaits: number;
  calls: number;
}
export interface InterpreterInfo {
  version: string;
  executable: string;
  base_prefix: string;
  path: string[];
  libdir: string | null;
  ldlibrary: string | null;
  instsoname: string | null;
  multiarch: string | null;
  framework_prefix: string | null;
  abiflags: string;
  dll: string | null;
}
