import assert from "node:assert/strict";
import { once } from "node:events";
import { it } from "node:test";
import { Worker } from "node:worker_threads";
import { Python } from "@node-ctypes/python";

it("hosts Python in a worker and rejects a second interpreter host", { timeout: 30_000 }, async () => {
  const worker = new Worker(new URL("../fixtures/worker.ts", import.meta.url));
  const exited = once(worker, "exit");
  try {
    const [message] = await once(worker, "message");
    assert.deepEqual(message, { answer: 42 });
    await assert.rejects(async () => await Python.initialize(), /thread|host|already/i);
  } finally {
    worker.postMessage("finalize");
    const [code] = await exited;
    assert.equal(code, 0);
  }
});
