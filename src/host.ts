// Copyright (c) 2026 Damiano Mazzella. MIT License (see LICENSE).
import { constants as fileFlags } from "node:fs";
import { constants as system } from "node:os";
import { CDLL, WinDLL, c_char_p, c_int, c_uint, c_void_p, c_wchar_p } from "node-ctypes";
import type { FFIType } from "node-ctypes";
import type { NativeFunction } from "./native.ts";

const BUSY = "Python already has an interpreter host or an abandoned host reservation in this process: one thread hosts the interpreter, use it from there.";
let release: (() => void) | undefined;

function nativeError(operation: string, code: number): Error {
  return new Error(`${operation} failed while managing the Python host (native error ${code})`);
}

function claimWindows(): () => void {
  const library = new WinDLL("kernel32.dll", { use_last_error: true });
  try {
    const create: NativeFunction<[typeof c_void_p, typeof c_int, typeof c_wchar_p], typeof c_void_p> = library.CreateMutexW;
    create.argtypes = [c_void_p, c_int, c_wchar_p];
    create.restype = c_void_p;
    const unlock: NativeFunction<[typeof c_void_p], typeof c_int> = library.ReleaseMutex;
    unlock.argtypes = [c_void_p];
    unlock.restype = c_int;
    const close: NativeFunction<[typeof c_void_p], typeof c_int> = library.CloseHandle;
    close.argtypes = [c_void_p];
    close.restype = c_int;
    const handle = create(null, 1, `Local\\node-python-host-${process.pid}`);
    const error = library.get_last_error();
    if (handle === null) throw nativeError("CreateMutexW", error);
    if (error === 183) {
      if (!close(handle)) throw new AggregateError([new Error(BUSY), nativeError("CloseHandle", library.get_last_error())], "Python host rejection and handle cleanup failed");
      throw new Error(BUSY);
    }
    let unlocked = false;
    return () => {
      if (!unlocked) {
        if (!unlock(handle)) throw nativeError("ReleaseMutex", library.get_last_error());
        unlocked = true;
      }
      if (!close(handle)) throw nativeError("CloseHandle", library.get_last_error());
      library.close();
    };
  } catch (error) {
    try {
      library.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Python host acquisition and library cleanup failed");
    }
    throw error;
  }
}

function claimPosix(): () => void {
  const library = new CDLL(null, { use_errno: true });
  try {
    const open: NativeFunction<FFIType[], typeof c_void_p> = library.sem_open;
    // Only the two fixed arguments: mode/value must use the variadic ABI on Apple ARM64.
    open.argtypes = [c_char_p, c_int];
    open.restype = c_void_p;
    const unlink: NativeFunction<[typeof c_char_p], typeof c_int> = library.sem_unlink;
    unlink.argtypes = [c_char_p];
    unlink.restype = c_int;
    const close: NativeFunction<[typeof c_void_p], typeof c_int> = library.sem_close;
    close.argtypes = [c_void_p];
    close.restype = c_int;
    if (!process.geteuid) throw new Error("POSIX Python host ownership requires process.geteuid()");
    const name = `/npy-${process.geteuid().toString(16)}-${process.pid.toString(16)}`;
    // Exclusive creation is the reservation; contenders never open or wait on its handle.
    const handle = open(name, fileFlags.O_CREAT | fileFlags.O_EXCL, new c_uint(0o600), new c_uint(0));
    if (handle === null || handle === -1n || handle === 0xffffffffffffffffn || handle === 0xffffffffn) {
      const error = library.get_errno();
      if (error === system.errno.EEXIST) throw new Error(`${BUSY} POSIX semaphore: ${name}`);
      throw nativeError("sem_open", error);
    }
    let closed = false;
    return () => {
      if (!closed) {
        if (close(handle) !== 0) throw nativeError("sem_close", library.get_errno());
        closed = true;
      }
      // Remove the name last, so another host cannot enter before local cleanup finishes.
      if (unlink(name) !== 0) throw nativeError("sem_unlink", library.get_errno());
      library.close();
    };
  } catch (error) {
    try {
      library.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Python host acquisition and library cleanup failed");
    }
    throw error;
  }
}

export function claimHost(): void {
  if (release) throw new Error(BUSY);
  if (process.platform !== "win32" && process.platform !== "linux" && process.platform !== "darwin") throw new Error(`Native Python host ownership is not supported on ${process.platform}`);
  release = process.platform === "win32" ? claimWindows() : claimPosix();
}

export function releaseHost(): void {
  if (!release) return;
  release();
  release = undefined;
}
