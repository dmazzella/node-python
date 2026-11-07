import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { it, mock } from "node:test";
import { WinDLL, addressof, c_int, c_uint8, c_void_p } from "node-ctypes";
import { API, PythonLibrary } from "../../dist/native.js";
import type { NativeFunction } from "../../dist/native.js";
import { loadLibrary, probeInterpreter } from "../../dist/interpreter.js";

it("reports DLL-directory removal failures and permits an idempotent retry", { skip: process.platform !== "win32" }, async () => {
  const info = await probeInterpreter();
  const kernel = new WinDLL("kernel32.dll");
  const remove: NativeFunction<[typeof c_void_p], typeof c_int> = kernel.RemoveDllDirectory;
  remove.argtypes = [c_void_p];
  remove.restype = c_int;
  let failing = true;
  const removed = mock.fn((cookie: bigint) => (failing ? 0 : remove(cookie)));
  const nativeError = mock.method(WinDLL.prototype, "get_last_error", () => 5);
  Object.defineProperty(WinDLL.prototype, "RemoveDllDirectory", { configurable: true, value: removed });
  let loaded: ReturnType<typeof loadLibrary> | undefined;
  try {
    loaded = loadLibrary(info);
    assert.ok(loaded.release);
    assert.equal(loaded.lib.Py_IsInitialized(), 0);
    assert.throws(loaded.release, /RemoveDllDirectory.*native error 5/);
    failing = false;
    loaded.release();
    loaded.release();
    assert.equal(removed.mock.callCount(), 2, "one failed removal and one successful removal; repeated release must be inert");
  } finally {
    failing = false;
    loaded?.release?.();
    loaded?.lib.close();
    Reflect.deleteProperty(WinDLL.prototype, "RemoveDllDirectory");
    nativeError.mock.restore();
    kernel.close();
  }
});

it("loads explicitly selected Windows ABI3t forwarders in a fresh process", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows DLL forwarding is not available on this platform");
    return;
  }
  const info = await probeInterpreter();
  const library = path.join(info.base_prefix, "abi3t-compat", "python3t.dll");
  if (!existsSync(library)) {
    context.skip("The selected Python installation does not provide an ABI3t compatibility DLL");
    return;
  }
  const script = `
import assert from "node:assert/strict";
import { loadLibrary, probeInterpreter } from ${JSON.stringify(new URL("../../dist/interpreter.js", import.meta.url).href)};
const info = await probeInterpreter();
const { lib, library, release } = loadLibrary(info, process.argv[1]);
try {
  assert.equal(library, process.argv[1]);
  assert.ok(lib.Py_GetVersion().startsWith(info.version + " "));
  assert.equal(lib.Py_IsInitialized(), 0);
  console.log("ABI3t forwarder loaded");
} finally {
  lib.close();
  release?.();
}
`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script, library], {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
    timeout: 20_000,
    windowsHide: true,
  });
  assert.match(output, /ABI3t forwarder loaded/);
});

it("configures CPython through ctypes attributes and reads exported data with in_dll", async () => {
  const info = await probeInterpreter();
  const { lib, release } = loadLibrary(info);
  try {
    for (const name of Object.keys(API) as (keyof typeof API)[]) {
      const [restype, argtypes] = API[name];
      assert.equal(lib[name].restype, restype, `${name}.restype`);
      assert.deepEqual(lib[name].argtypes, [...argtypes], `${name}.argtypes`);
    }
    assert.match(lib.Py_GetVersion() ?? "", new RegExp(`^${info.version.replaceAll(".", "\\.")}`));
    assert.equal(lib.Py_IsInitialized(), 0);
    assert.ok(addressof(c_uint8.in_dll(lib, "_Py_NoneStruct")) > 0n);
    assert.ok(c_void_p.in_dll(lib, "PyExc_RuntimeError").value);
  } finally {
    lib.close();
    release?.();
  }
});

it("reports version mismatches before resolving the complete C API", async () => {
  const info = await probeInterpreter();
  const { lib, library, release } = loadLibrary(info);
  Object.defineProperty(PythonLibrary.prototype, "PyObject_Call", {
    configurable: true,
    get() {
      throw new Error("The complete C API was resolved before checking its version");
    },
  });
  try {
    const mismatch = { ...info, version: "999.0.0" };
    assert.throws(() => loadLibrary(mismatch, library), /Python.*999\.0\.0|999\.0\.0.*Python/);
    assert.throws(() => loadLibrary({ ...mismatch, libdir: null, dll: "node-python-missing.dll", framework_prefix: null, instsoname: library }), /Python.*999\.0\.0|999\.0\.0.*Python/);
  } finally {
    Reflect.deleteProperty(PythonLibrary.prototype, "PyObject_Call");
    lib.close();
    release?.();
  }
});
