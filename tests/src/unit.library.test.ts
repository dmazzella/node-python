import assert from "node:assert/strict";
import path from "node:path";
import { it, mock } from "node:test";
import { WinDLL, c_int, c_void_p } from "node-ctypes";
import { loadLibrary } from "../../dist/interpreter.js";
import type { NativeFunction } from "../../dist/native.js";
import type { InterpreterInfo } from "../../dist/types.js";

const info: InterpreterInfo = {
  version: "3.15.0",
  executable: process.execPath,
  base_prefix: path.dirname(process.execPath),
  path: [],
  libdir: null,
  ldlibrary: null,
  instsoname: null,
  multiarch: null,
  framework_prefix: null,
  abiflags: "",
  dll: "missing-node-python-library.dll",
};

it("reports AddDllDirectory failure before loading Python", { skip: process.platform !== "win32" }, () => {
  const nativeError = mock.method(WinDLL.prototype, "get_last_error", () => 5);
  Object.defineProperty(WinDLL.prototype, "AddDllDirectory", { configurable: true, value: () => null });
  try {
    assert.throws(() => loadLibrary(info), /AddDllDirectory.*native error 5/);
  } finally {
    Reflect.deleteProperty(WinDLL.prototype, "AddDllDirectory");
    nativeError.mock.restore();
  }
});

it("removes its DLL search directory when loading Python fails", { skip: process.platform !== "win32" }, () => {
  const kernel = new WinDLL("kernel32.dll", { use_last_error: true });
  const remove: NativeFunction<[typeof c_void_p], typeof c_int> = kernel.RemoveDllDirectory;
  remove.argtypes = [c_void_p];
  remove.restype = c_int;
  const removed = mock.fn(remove);
  Object.defineProperty(WinDLL.prototype, "RemoveDllDirectory", { configurable: true, value: removed });
  try {
    assert.throws(() => loadLibrary(info), /shared library.*not found/i);
    assert.equal(removed.mock.callCount(), 1);
  } finally {
    Reflect.deleteProperty(WinDLL.prototype, "RemoveDllDirectory");
    kernel.close();
  }
});
