import { parentPort } from "node:worker_threads";
import { Python } from "@node-ctypes/python";

if (!parentPort) throw new Error("This fixture must run in a worker");
const port = parentPort;
const python = await Python.initialize({ stdin: false });
port.postMessage({ answer: await python.eval("6 * 7") });
port.once("message", async () => {
  await python.finalize();
  port.close();
});
