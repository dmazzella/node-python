import type { PythonLibrary } from "../../src/native.ts";
import { c_char_p, c_int, c_void_p } from "node-ctypes";

declare const lib: PythonLibrary;
const version: string | null = lib.Py_GetVersion();
const initialized: number = lib.Py_IsInitialized();
const object: bigint | null = lib.PyImport_ImportModule("math");
lib.Py_GetVersion.argtypes = [];
lib.Py_GetVersion.restype = c_char_p;
lib.Py_IsInitialized.restype = c_int;
lib.PyImport_ImportModule.argtypes = [c_char_p];
lib.PyImport_ImportModule.restype = c_void_p;
void [version, initialized, object];

// @ts-expect-error a module name must be a C string, not an integer
lib.PyImport_ImportModule(123);
// @ts-expect-error Py_GetVersion takes no arguments
lib.Py_GetVersion(1);
// @ts-expect-error Py_IsInitialized returns an int, not a string
lib.Py_IsInitialized.restype = c_char_p;
// @ts-expect-error Py_GetVersion takes no arguments
lib.Py_GetVersion.argtypes = [c_int];
