import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const seconds = Number(process.env.NODE_PYTHON_STRESS_SECONDS ?? 60);
assert.ok(Number.isSafeInteger(seconds) && seconds > 0 && seconds * 1000 + 90_000 <= 0x7fffffff, "NODE_PYTHON_STRESS_SECONDS must be a positive whole number within the test timeout range");

it("stabilizes shared references under mixed queued work and drains accepted calls at shutdown", { timeout: seconds * 1000 + 90_000 }, () => {
  const child = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(new URL("../fixtures/runtime-stress.ts", import.meta.url)), String(seconds)], {
    encoding: "utf8",
    timeout: seconds * 1000 + 60_000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  console.log(child.stdout.trim());
});
