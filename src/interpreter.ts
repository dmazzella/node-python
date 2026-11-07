// Copyright (c) 2026 Damiano Mazzella. MIT License (see LICENSE).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import { WinDLL, c_int, c_wchar_p, c_void_p } from "node-ctypes";
import { PythonLibrary } from "./native.ts";
import type { NativeFunction } from "./native.ts";
import type { InterpreterInfo } from "./types.ts";
const PROBE = `import json, os, sys, sysconfig
v = sysconfig.get_config_var
print(json.dumps({
    "version": sys.version.split()[0],
    "executable": sys.executable,
    "base_prefix": sys.base_prefix,
    "path": sys.path[1:],
    "libdir": v("LIBDIR"),
    "ldlibrary": v("LDLIBRARY"),
    "instsoname": v("INSTSONAME"),
    "multiarch": v("MULTIARCH"),
    "framework_prefix": v("PYTHONFRAMEWORKPREFIX"),
    "abiflags": getattr(sys, "abiflags", ""),
    "dll": "python%d%d%s.dll" % (*sys.version_info[:2], "t" if v("Py_GIL_DISABLED") else "") if os.name == "nt" else None,
}))`;

function isInterpreterInfo(value: unknown): value is InterpreterInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (!("version" in value) || typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:(?:a|b|rc)\d+)?\+?$/.test(value.version)) return false;
  if (!("executable" in value) || typeof value.executable !== "string" || !path.isAbsolute(value.executable)) return false;
  if (!("base_prefix" in value) || typeof value.base_prefix !== "string" || !path.isAbsolute(value.base_prefix)) return false;
  if (!("path" in value) || !Array.isArray(value.path) || !value.path.every((item: unknown) => typeof item === "string")) return false;
  if (!("abiflags" in value) || typeof value.abiflags !== "string") return false;
  return ["libdir", "ldlibrary", "instsoname", "multiarch", "framework_prefix", "dll"].every((key) => {
    const item: unknown = Reflect.get(value, key);
    return item === null || typeof item === "string";
  });
}

/** Run the interpreter to read its version, paths and library location. */
export async function probeInterpreter(executable?: string): Promise<InterpreterInfo> {
  const commands = executable ? [[executable]] : process.env.PYTHON ? [[process.env.PYTHON]] : process.platform === "win32" ? [["py", "-3"], ["python"], ["python3"]] : [["python3"], ["python"]];
  const failures: Error[] = [];
  for (const [command, ...args] of commands) {
    try {
      const { stdout } = await promisify(execFile)(command, [...args, "-c", PROBE], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
      const info: unknown = JSON.parse(stdout);
      if (!isInterpreterInfo(info)) throw new TypeError("Interpreter probe returned invalid metadata");
      return info;
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      const code = "code" in error ? error.code : undefined;
      const killed = "killed" in error && error.killed === true;
      const reason =
        code === "ENOENT"
          ? "executable not found (ENOENT)"
          : killed && code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? "interpreter probe timed out after 10000ms"
            : typeof code === "number"
              ? `interpreter probe exited with status ${code}`
              : error instanceof SyntaxError
                ? "interpreter probe returned invalid JSON"
                : `${typeof code === "string" ? `${code}: ` : ""}${error.message.split("\n")[0]}`;
      failures.push(new Error(`${[command, ...args].join(" ")}: ${reason}`, { cause: error }));
    }
  }
  throw new AggregateError(failures, `Python interpreter discovery failed (${failures.map((error) => error.message).join("; ")}). Install Python 3 or pass Python.initialize({ executable }).`);
}

/** Possible paths of the Python shared library, most specific first. */
export function libraryCandidates(info: InterpreterInfo): string[] {
  if (process.platform === "win32") {
    if (!info.dll) throw new Error("Python interpreter did not report its DLL name");
    return [path.join(info.base_prefix, info.dll), path.join(path.dirname(info.executable), info.dll)];
  }
  const short = info.version.split(".").slice(0, 2).join(".") + (info.abiflags ?? ""); // "3.14t": free-threaded
  const candidates = [];
  const names = [info.instsoname, info.ldlibrary].filter((name): name is string => !!name && !name.endsWith(".a"));
  if (process.platform === "darwin") {
    if (info.framework_prefix && info.ldlibrary?.includes(".framework/")) {
      candidates.push(path.join(info.framework_prefix, info.ldlibrary));
    }
    names.push(`libpython${short}.dylib`);
  } else {
    names.push(`libpython${short}.so.1.0`, `libpython${short}.so`);
  }
  const dirs = [info.libdir, info.libdir && info.multiarch ? path.join(info.libdir, info.multiarch) : null].filter((dir): dir is string => !!dir);
  for (const dir of dirs) {
    for (const name of names) candidates.push(path.join(dir, name));
  }
  return [...new Set(candidates)];
}

function registerDllDirectory(directory: string): () => void {
  const kernel32 = new WinDLL("kernel32.dll", { use_last_error: true });
  try {
    const add: NativeFunction<[typeof c_wchar_p], typeof c_void_p> = kernel32.AddDllDirectory;
    add.argtypes = [c_wchar_p];
    add.restype = c_void_p;
    const remove: NativeFunction<[typeof c_void_p], typeof c_int> = kernel32.RemoveDllDirectory;
    remove.argtypes = [c_void_p];
    remove.restype = c_int;
    const cookie = add(directory);
    if (cookie === null) throw new Error(`AddDllDirectory failed for ${directory} (native error ${kernel32.get_last_error()})`);
    let removed = false;
    let closed = false;
    return () => {
      if (closed) return;
      if (!removed) {
        if (!remove(cookie)) throw new Error(`RemoveDllDirectory failed for ${directory} (native error ${kernel32.get_last_error()})`);
        removed = true;
      }
      kernel32.close();
      closed = true;
    };
  } catch (error) {
    try {
      kernel32.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "DLL directory registration and library cleanup failed");
    }
    throw error;
  }
}

/** Load libpython; release its Windows DLL-directory registration after Python stops. */
export function loadLibrary(info: InterpreterInfo, library?: string): { lib: PythonLibrary; library: string; release?: () => void } {
  const release = process.platform === "win32" ? registerDllDirectory(info.base_prefix) : undefined;
  try {
    if (library) return { lib: new PythonLibrary(library, info), library, release };
    const candidates = libraryCandidates(info);
    for (const candidate of candidates) {
      if (existsSync(candidate)) return { lib: new PythonLibrary(candidate, info), library: candidate, release };
    }
    // Linux: the soname may be found through the dynamic linker search path.
    if (info.instsoname) {
      try {
        return { lib: new PythonLibrary(info.instsoname, info), library: info.instsoname, release };
      } catch (error) {
        throw new Error(`Could not load ${info.instsoname} for ${info.executable}: ${error instanceof Error ? error.message : String(error)} (searched: ${candidates.join(", ")})`, { cause: error });
      }
    }
    throw new Error(`The Python shared library of ${info.executable} was not found (searched: ${candidates.join(", ")}). ` + "Python must be built with --enable-shared (Debian/Ubuntu: install libpython3.x), or pass Python.initialize({ library }).");
  } catch (error) {
    try {
      release?.();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Python library loading and DLL directory cleanup failed");
    }
    throw error;
  }
}
