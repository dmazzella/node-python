import assert from "node:assert/strict";
import { pbkdf2 } from "node:crypto";
import { Python } from "@node-ctypes/python";

assert.equal(process.env.UV_THREADPOOL_SIZE, "1");
const python = await Python.initialize({ stdin: false });
try {
  let cryptoDone = false;
  const blocker = new Promise<void>((resolve, reject) => {
    pbkdf2("executor-pool-test", "salt", 1_000_000, 32, "sha256", (error) => {
      cryptoDone = true;
      if (error) reject(error);
      else resolve();
    });
  });
  try {
    assert.equal(await python.eval("6 * 7"), 42);
    assert.equal(cryptoDone, false, "Python must complete without waiting for the occupied libuv worker");
  } finally {
    await blocker;
  }
} finally {
  await python.finalize();
}
