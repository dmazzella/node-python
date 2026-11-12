import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { Python } from "@node-ctypes/python";
import { CDLL, c_char_p, c_int } from "node-ctypes";
import type { NativeFunction } from "../../dist/native.js";

it("completes Python work independently of a saturated libuv pool", () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("../fixtures/executor-pool.ts", import.meta.url))], {
    env: { ...process.env, UV_THREADPOOL_SIZE: "1" },
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
});

it("batches automatic proxy releases without starving Node.js timers", () => {
  const child = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(new URL("../fixtures/executor-gc.ts", import.meta.url))], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
});

it("fails explicitly for an invalid interpreter, then initializes and finalizes safely", async () => {
  for (const nativeObjects of [false, true, { synchronousCallbacks: true }]) {
    await assert.rejects(() => Reflect.apply(Python.initialize, Python, [{ nativeObjects }]), /nativeObjects has been removed/);
  }
  for (const synchronousCallbacks of ["yes", null, 1, {}]) {
    await assert.rejects(() => Reflect.apply(Python.initialize, Python, [{ synchronousCallbacks }]), /synchronousCallbacks must be a boolean/);
  }
  await assert.rejects(async () => await Python.initialize({ executable: "node-python-nonexistent-executable" }), /python|interpreter|ENOENT|executable/i);
  const python = await Python.initialize({ stdin: false });
  const items = python.toPython([1, 2, 3]);
  assert.equal(await python.eval("6 * 7"), 42);
  const accepted = Array.from({ length: 32 }, (_, index) => python.eval(`${index} * 2`));
  const closing = python.finalize();
  const refused = assert.rejects(() => python.eval("1"), /closing|finaliz|closed/i);
  assert.deepEqual(
    await Promise.all(accepted),
    Array.from({ length: 32 }, (_, index) => index * 2),
    "finalization must drain every accepted request",
  );
  await closing;
  await refused;
  await python.finalize();
  await assert.rejects(async () => await python.eval("1"), /finaliz|closed/i);
  assert.throws(() => items.toJS(), /finaliz|released|closed/i);
});

for (const scenario of [
  "pre-initialize-error",
  "host-claim-error",
  ...(process.platform === "win32" ? ["dll-directory-startup", "dll-directory-finalize"] : []),
  "startup-early",
  "native-objects-error",
  "no-shared-array-buffer",
  "console-output",
  "executor-cache-error",
  "executor-start-error",
  "executor-enqueue-error",
  "executor-completion-error",
  "startup-late",
  "startup-cleanup-error",
  "finalize-error",
  "host-release-error",
  "shutdown-error",
  "multiple-errors",
  "reentrant-finalize",
  "stats-finalize",
  "finalize-gil-contention",
  "switch-interval",
  "switch-interval-explicit",
  "exit-callback",
  "exit-abandon-error",
  "exit-abandon-error-pending",
  "abandoned-host",
  "pending-calls",
  "pending-error-dispose",
  "pending-thread-callback",
  "late-result",
  "loop-start-error",
  "async-shutdown-error",
  "synchronous-callbacks",
  "atexit-callback",
]) {
  it(`handles lifecycle scenario ${scenario} in an isolated process`, () => {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("../fixtures/lifecycle.ts", import.meta.url)), scenario], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, `Lifecycle child ${scenario} failed:\n${child.stderr}`);
    const output = child.stdout;
    if (scenario === "exit-callback" || scenario.startsWith("exit-abandon-error")) {
      assert.equal(child.stderr, "", "a zero exit code must not hide an unhandled callback error");
    }
    if (scenario.startsWith("exit-abandon-error")) assert.match(output, /EXIT_ABANDON_ERROR_PROPAGATED/);
    if (process.platform !== "win32" && (scenario === "exit-callback" || scenario === "abandoned-host")) {
      const name = /^HOST_SEMAPHORE=(\/npy-[0-9a-f]+-[0-9a-f]+)$/m.exec(output)?.[1];
      assert.ok(name, "the terminated child must identify its abandoned test semaphore");
      const library = new CDLL(null, { use_errno: true });
      try {
        const unlink: NativeFunction<[typeof c_char_p], typeof c_int> = library.sem_unlink;
        unlink.argtypes = [c_char_p];
        unlink.restype = c_int;
        assert.equal(unlink(name), 0, `the abandoned semaphore must persist until explicit cleanup (errno ${library.get_errno()})`);
      } finally {
        library.close();
      }
    }
  });
}
