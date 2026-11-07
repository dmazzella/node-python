import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

it("retains a bounded backlog behind a slow head, drains every outcome and finalizes under load", { timeout: 100_000 }, () => {
  const child = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(new URL("../fixtures/executor-backlog.ts", import.meta.url))], {
    encoding: "utf8",
    timeout: 90_000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.error) throw new Error(`${child.stdout}\n${child.stderr}`, { cause: child.error });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  assert.equal(child.stderr, "");
  console.log(child.stdout.trim());
});
