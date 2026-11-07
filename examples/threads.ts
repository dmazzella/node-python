// threads — Python threads running alongside the Node.js event loop
//
// Public Python calls execute on a Python-owned execution thread, leaving Node.js
// free to run timers and I/O. Python threads also keep working independently;
// Python futures are awaited from JavaScript like promises.
//
// Usage:
//   node examples/threads.ts

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Python, PythonError, kwargs, type PythonObject } from "@node-ctypes/python";

const python = await Python.initialize({
  // Every Python call takes the GIL on the Node.js thread: a short switch
  // interval keeps the event loop responsive while Python threads compute.
  switchInterval: 0.5,
});
const threading = await python.import("threading");
const futures = await python.import("concurrent.futures");

console.log("═══════════════════════════════════════════════════════════");
console.log(` Python threads + Node.js event loop (Python ${python.version})`);
console.log("═══════════════════════════════════════════════════════════\n");

try {
  // [1] Python threads report progress through a queue; JavaScript awaits
  //     queue.get() while a Node.js timer keeps ticking
  console.log("[1] two Python threads count primes; Node.js keeps running");
  await python.exec(`
import math, queue, time

def count_primes(start, stop):
    return sum(1 for n in range(max(start, 2), stop) if all(n % d for d in range(2, math.isqrt(n) + 1)))

progress = queue.Queue()

def worker(name, start, stop, steps=4):
    size = (stop - start) // steps
    total = 0
    for i in range(steps):
        total += count_primes(start + i * size, start + (i + 1) * size)
        progress.put((name, i + 1, steps))
    progress.put((name, "done", total))
`);
  const { progress, worker } = python.main;
  const started = Date.now();
  for (const [name, start, stop] of [
    ["low", 0, 150_000],
    ["high", 150_000, 300_000],
  ]) {
    const thread = await threading.Thread(kwargs({ target: worker, args: [name, start, stop], daemon: true }));
    await thread.start();
  }

  let ticks = 0;
  const ticker = setInterval(() => ticks++, 20);
  const totals: Record<string, number> = {};
  try {
    while (Object.keys(totals).length < 2) {
      const message: PythonObject = await progress.get(); // blocks a Python thread, not Node.js
      const [name, step, value] = message.toJS<[string, number | "done", number]>();
      if (step === "done") {
        totals[name] = value;
        console.log(`    ${name}: ${value} primes`);
      } else {
        console.log(`    ${name}: step ${step}/${value}  (Node.js timer tick ${ticks})`);
      }
    }
  } finally {
    clearInterval(ticker);
  }
  console.log(`    total ${totals.low + totals.high} primes in ${Date.now() - started} ms, ${ticks} timer ticks meanwhile\n`);

  // [2] concurrent.futures awaited as promises, together with Node.js I/O
  console.log("[2] await Python futures and Node.js I/O together");
  await python.exec(`
def sleepy():
    time.sleep(0.2)
    return "slept 200 ms"
`);
  const executor = await futures.ThreadPoolExecutor(kwargs({ max_workers: 2 }));
  const [primes, slept, source] = await Promise.all([
    executor.submit(python.main.count_primes, 0, 100_000), // a Python future
    executor.submit(python.main.sleepy), // another Python future
    readFile(new URL(import.meta.url), "utf8"), // Node.js I/O
  ]);
  console.log(`    primes below 100000: ${primes} | ${slept} | read this file: ${source.length} chars`);

  try {
    await executor.submit(python.main.count_primes, "a", "b");
  } catch (error) {
    if (!(error instanceof PythonError) || error.type !== "TypeError") throw error;
    console.log(`    a failed future rejects the promise with a ${error.name}: ${error.message}`);
  }
  await executor.shutdown();
  console.log();

  // [3] Python threads calling JavaScript: the call runs on the Node.js main
  //     thread and returns a concurrent.futures.Future
  console.log("[3] Python threads calling JavaScript functions");
  python.module("node", {
    hash: (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12),
    // An async function: the future waits for its promise.
    fetch_size: async (url: string) => (await readFile(new URL(url))).length,
  });
  await python.exec(`
import node, threading

def checksum(text):
    # .result() waits for Node.js: fine in a worker thread awaited by JavaScript
    return f"{threading.current_thread().name}: {text} → {node.hash(text).result()}"

def size(url):
    return node.fetch_size(url).result()
`);
  const { checksum, size } = python.main;
  const pool = await futures.ThreadPoolExecutor(kwargs({ max_workers: 3 }));
  const lines = await Promise.all(["alpha", "beta", "gamma"].map((word) => pool.submit(checksum, word)));
  for (const line of lines) console.log(`    ${line}`);
  console.log(`    this file read by Node.js for a Python thread: ${await pool.submit(size, import.meta.url)} bytes`);
  await pool.shutdown();

  // Synchronous Python code joining a thread that calls JavaScript: the Python
  // executor waits while the Node.js event loop serves the callback.
  await python.exec(`
joined = []
t = threading.Thread(target=lambda: joined.append(checksum("delta")))
t.start()
t.join(3)  # not a deadlock: node.hash() runs on the main thread meanwhile
`);
  const joined = await python.eval<string[]>("joined");
  if (joined.length !== 1) throw new Error("The callback was not served while Python joined its worker");
  console.log(`    from a thread joined by synchronous Python code: ${joined[0]}`);

  console.log("\n    Done!");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await python.finalize();
}
