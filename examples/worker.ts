// worker — Python hosted by a worker thread
//
// One JavaScript thread per process hosts the embedded Python: here a worker.
// Python execution already uses a Python-owned thread; a JavaScript worker is
// optional isolation for host-side conversions and synchronous live properties.
// The main thread sends jobs with postMessage and stays responsive meanwhile.
//
// Usage:
//   node examples/worker.ts

import { Worker, isMainThread, parentPort } from "node:worker_threads";

type Job = "version" | "count_primes" | "pi_digits";
type Request = { id: number; job: Job; args: unknown[] } | { job: "exit" };
type Response = { id: number; result?: unknown; error?: string };

if (isMainThread) await main();
else await host();

// ─── main thread ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log(" Python in a worker thread");
  console.log("═══════════════════════════════════════════════════════════\n");

  const python = startPythonWorker();
  try {
    // [1] a first job
    const version = await python.run<string>("version");
    console.log(`[1] Python ${version} runs in the worker\n`);

    // [2] two CPU-bound jobs while a main thread timer keeps ticking
    console.log("[2] CPU-bound Python jobs; the main thread keeps running");
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 10);
    const started = Date.now();
    const jobs = Promise.all([python.run<number>("count_primes", 300_000), python.run<string>("pi_digits", 4_000)]);
    const [primes, digits] = await jobs.finally(() => clearInterval(ticker));
    console.log(`    primes below 300000: ${primes} | pi: ${digits.slice(0, 20)}... (${digits.length} digits)`);
    console.log(`    ${Date.now() - started} ms, main thread timer ticked ${ticks} times meanwhile\n`);

    // [3] a Python exception becomes a rejected job
    console.log("[3] Python errors reach the main thread");
    try {
      await python.run("count_primes", "many");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("TypeError")) throw error;
      console.log(`    ${error.message}\n`);
    }

    // [4] the worker owns Python: the main thread cannot initialize it too
    console.log("[4] only one thread per process can host Python");
    const { Python } = await import("@node-ctypes/python");
    let refused: Error | undefined;
    try {
      await Python.initialize();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      refused = error;
    }
    if (!refused) throw new Error("Python unexpectedly initialized on a second host thread");
    console.log(`    main thread: ${refused.message}`);
  } finally {
    await python.close();
  }
  console.log("\n    Done!");
}

/**
 * A minimal RPC client for the worker below: every job gets an id, and the
 * worker answers with the same id. If the worker fails or exits early, every
 * pending and future job is rejected with that error.
 */
function startPythonWorker() {
  const worker = new Worker(new URL(import.meta.url));
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let failure: Error | undefined;

  const failAll = (error: Error) => {
    failure ??= error;
    for (const job of pending.values()) job.reject(failure);
    pending.clear();
  };

  worker.on("message", ({ id, result, error }: Response) => {
    const job = pending.get(id);
    pending.delete(id);
    if (!job) failAll(new Error(`Unexpected Python worker response ${id}`));
    else if (error) job.reject(new Error(error));
    else job.resolve(result);
  });
  worker.on("error", failAll);

  const exited = new Promise<void>((resolve) => {
    worker.once("exit", (code) => {
      if (code !== 0 || pending.size) failAll(new Error(`Python worker exited with code ${code} (${pending.size} pending jobs)`));
      resolve();
    });
  });

  return {
    run<T>(job: Job, ...args: unknown[]): Promise<T> {
      if (failure) return Promise.reject(failure);
      const id = nextId++;
      const result = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
      worker.postMessage({ id, job, args } satisfies Request);
      return result as Promise<T>;
    },
    /** Let the worker finalize Python, then wait for it to exit. */
    async close(): Promise<void> {
      if (!failure) worker.postMessage({ job: "exit" } satisfies Request);
      await exited;
      if (failure) throw failure;
    },
  };
}

// ─── worker thread ──────────────────────────────────────────────────────────

async function host(): Promise<void> {
  const { Python, PythonError } = await import("@node-ctypes/python");
  const port = parentPort;
  if (!port) throw new Error("Python worker has no parent message port");

  const python = await Python.initialize();
  await python.exec(`
import math, sys

def version():
    return sys.version.split()[0]

def count_primes(limit):
    # trial division in pure Python: CPU-bound on purpose
    return sum(1 for n in range(2, limit) if all(n % d for d in range(2, math.isqrt(n) + 1)))

def pi_digits(count):
    # Machin's formula with integers
    def arctan(x, unity):
        total = term = unity // x
        n, sign = 3, -1
        while term:
            term //= x * x
            total += sign * (term // n)
            n, sign = n + 2, -sign
        return total
    unity = 10 ** (count + 10)
    pi = 4 * (4 * arctan(5, unity) - arctan(239, unity))
    return str(pi)[:count]
`);

  port.on("message", async (request: Request) => {
    if (request.job === "exit") {
      await python.finalize();
      port.close();
      return;
    }
    const { id, job, args } = request;
    try {
      const result = await python.main[job](...args);
      port.postMessage({ id, result } satisfies Response);
    } catch (error) {
      const message = error instanceof PythonError ? error.message : String(error);
      port.postMessage({ id, error: message } satisfies Response);
    }
  });
}
