import { parentPort } from "node:worker_threads";
import { claimHost, releaseHost } from "../../dist/host.js";

if (!parentPort) throw new Error("Host fixture requires a worker");
const port = parentPort;
port.once("message", () => {
  try {
    claimHost();
  } catch (error) {
    if (!(error instanceof Error) || !/already has an interpreter host/.test(error.message)) throw error;
    releaseHost();
    port.postMessage(false);
    port.close();
    return;
  }
  port.once("message", (command) => {
    if (command === "release") releaseHost();
    else if (command !== "abandon") throw new Error("Unknown host fixture command");
    port.close();
  });
  port.postMessage(true);
});
port.postMessage("ready");
