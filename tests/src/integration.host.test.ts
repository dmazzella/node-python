import assert from "node:assert/strict";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { it } from "node:test";
import { Worker } from "node:worker_threads";
import { claimHost, releaseHost } from "../../dist/host.js";

it("rejects recursive claims and releases ownership idempotently", () => {
  claimHost();
  try {
    assert.throws(claimHost, /already has an interpreter host/);
  } finally {
    releaseHost();
  }
  releaseHost();
  claimHost();
  releaseHost();
});

it("coordinates separate module instances without sharing JavaScript state", async () => {
  const other = await import(new URL("../../dist/host.js?independent", import.meta.url).href);
  claimHost();
  try {
    assert.throws(() => other.claimHost(), /already has an interpreter host/);
    other.releaseHost();
    assert.throws(() => other.claimHost(), /already has an interpreter host/);
  } finally {
    releaseHost();
  }
  other.claimHost();
  other.releaseHost();
  claimHost();
  releaseHost();
});

it("does not reserve the interpreter of a different process", () => {
  claimHost();
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", `import { claimHost, releaseHost } from ${JSON.stringify(new URL("../../dist/host.js", import.meta.url).href)}; claimHost(); releaseHost();`], { encoding: "utf8", timeout: 15_000 });
    assert.throws(claimHost, /already has an interpreter host/);
  } finally {
    releaseHost();
  }
});

it("grants exactly one host under simultaneous worker contention", { timeout: 30_000 }, async () => {
  const workers = Array.from({ length: 8 }, () => new Worker(new URL("../fixtures/host-worker.ts", import.meta.url)));
  const exits = workers.map((worker) => once(worker, "exit"));
  try {
    await Promise.all(workers.map((worker) => once(worker, "message").then(([message]) => assert.equal(message, "ready"))));
    const claims = workers.map((worker) => once(worker, "message").then(([claimed]) => claimed));
    for (const worker of workers) worker.postMessage("claim");
    const results = await Promise.all(claims);
    assert.equal(results.filter((claimed) => claimed === true).length, 1);
    assert.equal(results.filter((claimed) => claimed === false).length, 7);
    assert.throws(claimHost, /already has an interpreter host/);
    workers[results.indexOf(true)].postMessage("release");
    for (const [code] of await Promise.all(exits)) assert.equal(code, 0);
    claimHost();
    releaseHost();
  } finally {
    for (const worker of workers) worker.postMessage("release");
    await Promise.all(exits);
  }
});
