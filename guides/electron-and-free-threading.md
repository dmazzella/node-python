---
title: Electron and free-threaded Python
---

# Electron and free-threaded Python

## Running in Electron

`@node-ctypes/python` works in Electron main processes and Node-enabled renderers with no Electron-specific native rebuild:

- **Non-blocking UI**: all Python calls, `exec`, `eval` and `import` run on the dedicated `Executor` thread, keeping Chromium's UI thread responsive.
- **Consoleless stdout/stderr**: in an Electron renderer or packaged Windows GUI app without an attached console, Python's `sys.stdout` and `sys.stderr` are `None` (`"inherit"` discards output). Initialize with `stdout: "console", stderr: "console"` (forwards whole lines to DevTools `console.log` / `console.error`) or pass a custom logging callback.
- **Mirror mode (`NODE_CTYPES_NO_EXTERNAL_BUFFERS=1`)**: Electron's V8 memory cage forbids external `ArrayBuffer`s over non-V8 memory (`EXTERNAL_BUFFERS === false`). Under mirror mode:
  - `proxy.toTypedArray()` automatically copies writable Python buffers and immediately releases the Python buffer export lock (so Python can keep resizing `bytearray`s without `BufferError`).
  - `npm run test:mirror` runs the entire test suite with `NODE_CTYPES_NO_EXTERNAL_BUFFERS=1`.
- **Electron verification scripts**: after `npm run build`, run (with `ELECTRON_RUN_AS_NODE` unset):
  - `electron tests/electron/main.mjs` — prints a JSON report verifying calls, a free UI thread during long calls, and call bursts;
  - `electron tests/electron/ui/main.mjs` — opens an interactive window charting frame times and IPC latency during main-process and renderer bursts (`--auto` runs both and exits).

## Free-threaded CPython (`3.13t` / `3.14t`)

`@node-ctypes/python` supports free-threaded CPython builds (`Py_GIL_DISABLED=1`, `sys._is_gil_enabled() == False`):

- **Selecting a free-threaded runtime**: pass the free-threaded executable explicitly via `Python.initialize({ executable })` or the `PYTHON` environment variable (for example `python3.14t` or `python3.13t.exe`). Discovery automatically resolves the matching `python3XXt.dll` / `libpython3.XXt.so` / `libpython3.XXt.dylib`. An ABI3t compatibility DLL alone does not enable free threading.
- **Biased reference counting and destructors**: calling `proxy[Symbol.dispose]()` drops the reference immediately. On free-threaded builds, when the last reference is dropped from a thread other than the thread that created the Python object (typically the executor thread), CPython's biased reference counting defers running `__del__` until the creating thread next executes Python code.
- **Thread safety**:
  - `nativeSlot` callbacks detach/reattach Python thread state around cross-thread calls via `PyEval_SaveThread` / `PyEval_RestoreThread`.
  - JavaScript conversions always execute on the single hosting Node.js thread.
- **CI coverage**: the CI matrix tests free-threaded CPython (`3.14t`) alongside GIL builds (`3.12`, `3.13`, `3.14`, `3.15`) on Windows, Linux and macOS.
