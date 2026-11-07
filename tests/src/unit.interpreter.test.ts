import assert from "node:assert/strict";
import childProcess from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { it, mock } from "node:test";
import { promisify } from "node:util";
import { probeInterpreter } from "../../dist/interpreter.js";
import type { InterpreterInfo } from "../../dist/types.js";

const info: InterpreterInfo = {
  version: "3.15.0a1",
  executable: process.execPath,
  base_prefix: path.dirname(process.execPath),
  path: ["", path.dirname(process.execPath)],
  libdir: null,
  ldlibrary: null,
  instsoname: null,
  multiarch: null,
  framework_prefix: null,
  abiflags: "",
  dll: process.platform === "win32" ? "python315.dll" : null,
};

function probeResult(operation: (options: ExecFileOptions, command: string) => unknown | Promise<unknown>) {
  const original = Object.getOwnPropertyDescriptor(childProcess, "execFile");
  assert.ok(original);
  const replacement = () => {
    throw new Error("The probe must use the promise-based execution path");
  };
  Object.defineProperty(replacement, promisify.custom, {
    configurable: true,
    value: mock.fn(async (command: string, _args: string[], options: ExecFileOptions) => operation(options, command)),
  });
  Object.defineProperty(childProcess, "execFile", { configurable: true, writable: true, value: replacement });
  syncBuiltinESMExports();
  return () => {
    Object.defineProperty(childProcess, "execFile", original);
    syncBuiltinESMExports();
  };
}

it("bounds discovery and preserves valid interpreter metadata", async () => {
  const restore = probeResult((options) => {
    assert.equal(options.timeout, 10_000);
    assert.equal(options.windowsHide, true);
    return { stdout: JSON.stringify(info), stderr: "" };
  });
  try {
    assert.deepEqual(await probeInterpreter("selected-python"), info);
  } finally {
    restore();
  }
});

it("rejects malformed or incomplete interpreter metadata explicitly", async () => {
  for (const value of [null, [], {}, { ...info, version: "unknown" }, { ...info, path: [42] }, { ...info, libdir: 42 }, { ...info, executable: "" }, { ...info, base_prefix: "" }]) {
    const restore = probeResult(() => ({ stdout: JSON.stringify(value), stderr: "" }));
    try {
      await assert.rejects(() => probeInterpreter("selected-python"), /invalid.*metadata/i);
    } finally {
      restore();
    }
  }
});

it("distinguishes malformed JSON from an executable that cannot be found", async () => {
  for (const [result, message] of [
    [() => ({ stdout: "not JSON", stderr: "" }), /invalid JSON/i],
    [
      () => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      },
      /executable not found.*ENOENT/i,
    ],
    [
      () => {
        throw Object.assign(new Error("startup failed"), { code: 7 });
      },
      /probe.*exit.*7/i,
    ],
    [
      () => {
        throw Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM", code: null });
      },
      /timed out.*10000/i,
    ],
  ] as const) {
    const restore = probeResult(result);
    try {
      await assert.rejects(
        () => probeInterpreter("selected-python"),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.match(error.message, message);
          assert.equal(error.errors.length, 1);
          assert.ok(error.errors[0].cause instanceof Error);
          return true;
        },
      );
    } finally {
      restore();
    }
  }
});

it("preserves default-command fallback without overriding an explicitly selected interpreter", async () => {
  const saved = process.env.PYTHON;
  delete process.env.PYTHON;
  const commands: string[] = [];
  const restore = probeResult((_options, command) => {
    commands.push(command);
    if (commands.length === 1) throw Object.assign(new Error("not found"), { code: "ENOENT" });
    return { stdout: JSON.stringify(info), stderr: "" };
  });
  try {
    assert.deepEqual(await probeInterpreter(), info);
    assert.deepEqual(commands, process.platform === "win32" ? ["py", "python"] : ["python3", "python"]);
  } finally {
    restore();
    if (saved === undefined) delete process.env.PYTHON;
    else process.env.PYTHON = saved;
  }
});
