// Copyright (c) 2026 Damiano Mazzella. MIT License (see LICENSE).
import { CDLL, RTLD_GLOBAL, Structure, CFUNCTYPE, c_char_p, c_void_p, c_int, c_uint, c_long, c_ulong, c_int64, c_double, c_ssize_t } from "node-ctypes";
import type { FFIType, FunctionWrapper, TypedFFIFunction } from "node-ctypes";
import type { InterpreterInfo } from "./types.ts";
export const MIN_PYTHON = [3, 12];
export const Py_file_input = 257;
export const Py_eval_input = 258;
export const METH_VARARGS = 0x0001;
export const METH_KEYWORDS = 0x0002;
export const METH_NOARGS = 0x0004;

// PyObject *f(PyObject *self, PyObject *args, PyObject *kwargs)
export const PyCFunctionWithKeywords = CFUNCTYPE(c_void_p, c_void_p, c_void_p, c_void_p);

export class PyMethodDef extends Structure {
  static _fields_ = [
    ["ml_name", c_char_p],
    ["ml_meth", PyCFunctionWithKeywords],
    ["ml_flags", c_int],
    ["ml_doc", c_char_p],
  ];
}

export class PyCFunctionMethodDef extends Structure {
  static _fields_ = [
    ["ml_name", c_char_p],
    ["ml_meth", CFUNCTYPE(c_void_p, c_void_p, c_void_p)],
    ["ml_flags", c_int],
    ["ml_doc", c_char_p],
  ];
}

export class PyTypeSlot extends Structure {
  static _fields_ = [
    ["slot", c_int],
    ["pfunc", c_void_p],
  ];
}

export class PyTypeSpec extends Structure {
  static _fields_ = [
    ["name", c_char_p],
    ["basicsize", c_int],
    ["itemsize", c_int],
    ["flags", c_uint],
    ["slots", c_void_p],
  ];
}

// Functions used here (stable ABI): name → [restype, argtypes]
export const API = {
  Py_GetVersion: [c_char_p, []],
  Py_IsInitialized: [c_int, []],
  Py_InitializeEx: [null, [c_int]],
  Py_FinalizeEx: [c_int, []],
  PyEval_SaveThread: [c_void_p, []],
  PyEval_RestoreThread: [null, [c_void_p]],
  PyGILState_Ensure: [c_int, []],
  PyGILState_Release: [null, [c_int]],
  PyGC_Collect: [c_ssize_t, []],
  Py_CompileString: [c_void_p, [c_char_p, c_char_p, c_int]],
  PyEval_EvalCode: [c_void_p, [c_void_p, c_void_p, c_void_p]],
  PyEval_GetBuiltins: [c_void_p, []],
  PyImport_ImportModule: [c_void_p, [c_char_p]],
  PyModule_GetDict: [c_void_p, [c_void_p]],
  PyObject_GetAttrString: [c_void_p, [c_void_p, c_char_p]],
  PyObject_GenericGetAttr: [c_void_p, [c_void_p, c_void_p]],
  PyObject_GenericSetAttr: [c_int, [c_void_p, c_void_p, c_void_p]],
  PyObject_GetTypeData: [c_void_p, [c_void_p, c_void_p]],
  PyObject_SetAttrString: [c_int, [c_void_p, c_char_p, c_void_p]],
  PyObject_HasAttrString: [c_int, [c_void_p, c_char_p]],
  PyObject_GetItem: [c_void_p, [c_void_p, c_void_p]],
  PyObject_SetItem: [c_int, [c_void_p, c_void_p, c_void_p]],
  PyObject_Call: [c_void_p, [c_void_p, c_void_p, c_void_p]],
  PyObject_Str: [c_void_p, [c_void_p]],
  PyObject_Repr: [c_void_p, [c_void_p]],
  PyObject_Type: [c_void_p, [c_void_p]],
  PyObject_Hash: [c_ssize_t, [c_void_p]],
  PyObject_RichCompare: [c_void_p, [c_void_p, c_void_p, c_int]],
  PyObject_IsInstance: [c_int, [c_void_p, c_void_p]],
  PyObject_IsTrue: [c_int, [c_void_p]],
  PyObject_GetIter: [c_void_p, [c_void_p]],
  PyIter_Next: [c_void_p, [c_void_p]],
  PyErr_Occurred: [c_void_p, []],
  PyErr_GetRaisedException: [c_void_p, []],
  PyErr_SetRaisedException: [null, [c_void_p]],
  PyErr_SetString: [null, [c_void_p, c_char_p]],
  PyType_GetName: [c_void_p, [c_void_p]],
  PyType_FromSpec: [c_void_p, [c_void_p]],
  PyType_FromSpecWithBases: [c_void_p, [c_void_p, c_void_p]],
  PyType_GenericAlloc: [c_void_p, [c_void_p, c_ssize_t]],
  PyType_GetSlot: [c_void_p, [c_void_p, c_int]],
  PyErr_Clear: [null, []],
  PyErr_ExceptionMatches: [c_int, [c_void_p]],
  PyThreadState_SetAsyncExc: [c_int, [c_ulong, c_void_p]],
  Py_IncRef: [null, [c_void_p]],
  Py_DecRef: [null, [c_void_p]],
  PyBool_FromLong: [c_void_p, [c_long]],
  PyLong_FromLongLong: [c_void_p, [c_int64]],
  PyLong_FromDouble: [c_void_p, [c_double]],
  PyLong_FromString: [c_void_p, [c_char_p, c_void_p, c_int]],
  PyLong_AsLongLong: [c_int64, [c_void_p]],
  PyLong_AsLongLongAndOverflow: [c_int64, [c_void_p, c_void_p]],
  PyNumber_AsSsize_t: [c_ssize_t, [c_void_p, c_void_p]],
  PyFloat_FromDouble: [c_void_p, [c_double]],
  PyFloat_AsDouble: [c_double, [c_void_p]],
  PyUnicode_DecodeUTF8: [c_void_p, [c_void_p, c_ssize_t, c_char_p]],
  PyUnicode_AsUTF8AndSize: [c_void_p, [c_void_p, c_void_p]],
  PyBytes_FromStringAndSize: [c_void_p, [c_void_p, c_ssize_t]],
  PyBytes_AsStringAndSize: [c_int, [c_void_p, c_void_p, c_void_p]],
  PyTuple_New: [c_void_p, [c_ssize_t]],
  PyTuple_SetItem: [c_int, [c_void_p, c_ssize_t, c_void_p]],
  PyTuple_Size: [c_ssize_t, [c_void_p]],
  PyTuple_GetItem: [c_void_p, [c_void_p, c_ssize_t]],
  PyList_New: [c_void_p, [c_ssize_t]],
  PyList_SetItem: [c_int, [c_void_p, c_ssize_t, c_void_p]],
  PyList_Size: [c_ssize_t, [c_void_p]],
  PyList_GetItem: [c_void_p, [c_void_p, c_ssize_t]],
  PyDict_New: [c_void_p, []],
  PyDict_SetItem: [c_int, [c_void_p, c_void_p, c_void_p]],
  PyDict_SetItemString: [c_int, [c_void_p, c_char_p, c_void_p]],
  PyDict_GetItemString: [c_void_p, [c_void_p, c_char_p]],
  PyDict_Next: [c_int, [c_void_p, c_void_p, c_void_p, c_void_p]],
  PyDict_Size: [c_ssize_t, [c_void_p]],
  PySet_New: [c_void_p, [c_void_p]],
  PySet_Add: [c_int, [c_void_p, c_void_p]],
  PyCFunction_NewEx: [c_void_p, [c_void_p, c_void_p, c_void_p]],
} as const;

// Type objects compared with type(obj) to convert values to JavaScript.
export const TYPES = ["PyBool_Type", "PyLong_Type", "PyFloat_Type", "PyUnicode_Type", "PyBytes_Type", "PyList_Type", "PyTuple_Type", "PyDict_Type", "PySet_Type", "PyFrozenSet_Type"];

export type NativeFunction<TArgs extends readonly FFIType[], TRet extends FFIType | null> = TypedFFIFunction<TArgs, TRet> & { argtypes: [...TArgs]; restype: TRet };
export type NativeAPI = { [K in keyof typeof API]: NativeFunction<(typeof API)[K][1], (typeof API)[K][0]> };

export class PythonLibrary extends CDLL implements NativeAPI {
  declare Py_GetVersion: NativeAPI["Py_GetVersion"];
  declare Py_IsInitialized: NativeAPI["Py_IsInitialized"];
  declare Py_InitializeEx: NativeAPI["Py_InitializeEx"];
  declare Py_FinalizeEx: NativeAPI["Py_FinalizeEx"];
  declare PyEval_SaveThread: NativeAPI["PyEval_SaveThread"];
  declare PyEval_RestoreThread: NativeAPI["PyEval_RestoreThread"];
  declare PyGILState_Ensure: NativeAPI["PyGILState_Ensure"];
  declare PyGILState_Release: NativeAPI["PyGILState_Release"];
  declare PyGC_Collect: NativeAPI["PyGC_Collect"];
  declare Py_CompileString: NativeAPI["Py_CompileString"];
  declare PyEval_EvalCode: NativeAPI["PyEval_EvalCode"];
  declare PyEval_GetBuiltins: NativeAPI["PyEval_GetBuiltins"];
  declare PyImport_ImportModule: NativeAPI["PyImport_ImportModule"];
  declare PyModule_GetDict: NativeAPI["PyModule_GetDict"];
  declare PyObject_GetAttrString: NativeAPI["PyObject_GetAttrString"];
  declare PyObject_GenericGetAttr: NativeAPI["PyObject_GenericGetAttr"];
  declare PyObject_GenericSetAttr: NativeAPI["PyObject_GenericSetAttr"];
  declare PyObject_GetTypeData: NativeAPI["PyObject_GetTypeData"];
  declare PyObject_SetAttrString: NativeAPI["PyObject_SetAttrString"];
  declare PyObject_HasAttrString: NativeAPI["PyObject_HasAttrString"];
  declare PyObject_GetItem: NativeAPI["PyObject_GetItem"];
  declare PyObject_SetItem: NativeAPI["PyObject_SetItem"];
  declare PyObject_Call: NativeAPI["PyObject_Call"];
  declare PyObject_Str: NativeAPI["PyObject_Str"];
  declare PyObject_Repr: NativeAPI["PyObject_Repr"];
  declare PyObject_Type: NativeAPI["PyObject_Type"];
  declare PyObject_Hash: NativeAPI["PyObject_Hash"];
  declare PyObject_RichCompare: NativeAPI["PyObject_RichCompare"];
  declare PyObject_IsInstance: NativeAPI["PyObject_IsInstance"];
  declare PyObject_IsTrue: NativeAPI["PyObject_IsTrue"];
  declare PyObject_GetIter: NativeAPI["PyObject_GetIter"];
  declare PyIter_Next: NativeAPI["PyIter_Next"];
  declare PyErr_Occurred: NativeAPI["PyErr_Occurred"];
  declare PyErr_GetRaisedException: NativeAPI["PyErr_GetRaisedException"];
  declare PyErr_SetRaisedException: NativeAPI["PyErr_SetRaisedException"];
  declare PyErr_SetString: NativeAPI["PyErr_SetString"];
  declare PyType_GetName: NativeAPI["PyType_GetName"];
  declare PyType_FromSpec: NativeAPI["PyType_FromSpec"];
  declare PyType_FromSpecWithBases: NativeAPI["PyType_FromSpecWithBases"];
  declare PyType_GenericAlloc: NativeAPI["PyType_GenericAlloc"];
  declare PyType_GetSlot: NativeAPI["PyType_GetSlot"];
  declare PyErr_Clear: NativeAPI["PyErr_Clear"];
  declare PyErr_ExceptionMatches: NativeAPI["PyErr_ExceptionMatches"];
  declare PyThreadState_SetAsyncExc: NativeAPI["PyThreadState_SetAsyncExc"];
  declare Py_IncRef: NativeAPI["Py_IncRef"];
  declare Py_DecRef: NativeAPI["Py_DecRef"];
  declare PyBool_FromLong: NativeAPI["PyBool_FromLong"];
  declare PyLong_FromLongLong: NativeAPI["PyLong_FromLongLong"];
  declare PyLong_FromDouble: NativeAPI["PyLong_FromDouble"];
  declare PyLong_FromString: NativeAPI["PyLong_FromString"];
  declare PyLong_AsLongLong: NativeAPI["PyLong_AsLongLong"];
  declare PyLong_AsLongLongAndOverflow: NativeAPI["PyLong_AsLongLongAndOverflow"];
  declare PyNumber_AsSsize_t: NativeAPI["PyNumber_AsSsize_t"];
  declare PyFloat_FromDouble: NativeAPI["PyFloat_FromDouble"];
  declare PyFloat_AsDouble: NativeAPI["PyFloat_AsDouble"];
  declare PyUnicode_DecodeUTF8: NativeAPI["PyUnicode_DecodeUTF8"];
  declare PyUnicode_AsUTF8AndSize: NativeAPI["PyUnicode_AsUTF8AndSize"];
  declare PyBytes_FromStringAndSize: NativeAPI["PyBytes_FromStringAndSize"];
  declare PyBytes_AsStringAndSize: NativeAPI["PyBytes_AsStringAndSize"];
  declare PyTuple_New: NativeAPI["PyTuple_New"];
  declare PyTuple_SetItem: NativeAPI["PyTuple_SetItem"];
  declare PyTuple_Size: NativeAPI["PyTuple_Size"];
  declare PyTuple_GetItem: NativeAPI["PyTuple_GetItem"];
  declare PyList_New: NativeAPI["PyList_New"];
  declare PyList_SetItem: NativeAPI["PyList_SetItem"];
  declare PyList_Size: NativeAPI["PyList_Size"];
  declare PyList_GetItem: NativeAPI["PyList_GetItem"];
  declare PyDict_New: NativeAPI["PyDict_New"];
  declare PyDict_SetItem: NativeAPI["PyDict_SetItem"];
  declare PyDict_SetItemString: NativeAPI["PyDict_SetItemString"];
  declare PyDict_GetItemString: NativeAPI["PyDict_GetItemString"];
  declare PyDict_Next: NativeAPI["PyDict_Next"];
  declare PyDict_Size: NativeAPI["PyDict_Size"];
  declare PySet_New: NativeAPI["PySet_New"];
  declare PySet_Add: NativeAPI["PySet_Add"];
  declare PyCFunction_NewEx: NativeAPI["PyCFunction_NewEx"];

  constructor(library: string, interpreter?: Pick<InterpreterInfo, "version" | "executable">) {
    super(library, RTLD_GLOBAL);
    try {
      this.Py_GetVersion.argtypes = [];
      this.Py_GetVersion.restype = c_char_p;
      if (interpreter) {
        const version = this.Py_GetVersion()?.split(" ")[0];
        if (!version) throw new Error(`${library}: Py_GetVersion returned no version`);
        const minor = (value: string) => value.split(".").slice(0, 2).join(".");
        if (minor(version) !== minor(interpreter.version)) {
          throw new Error(
            `${library} is Python ${version}, but ${interpreter.executable} is Python ${interpreter.version}: ` +
              "pass the matching interpreter too (Python.initialize({ executable, library }), or the PYTHON and PYTHON_LIBRARY environment variables).",
          );
        }
      }
      for (const [name, [restype, argtypes]] of Object.entries(API)) {
        const function_: FunctionWrapper = this[name];
        function_.argtypes = [...argtypes];
        function_.restype = restype;
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }
}
