// async — asyncio coroutines and JavaScript promises together
//
// Python coroutines run on an asyncio event loop in a Python thread, next to
// the Node.js event loop: JavaScript awaits them as promises, and coroutines
// await JavaScript functions (async or not), which run on the Node.js main
// thread. The two loops are connected by a node-ctypes threadSafeCallback.
// Async iterators work in both directions (for await / async for), and so
// does cancellation (AbortSignal → task.cancel(), Python cancel → AbortSignal).
//
// Usage:
//   node examples/async.ts

import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Python, PythonError, cancellable, type PythonObject } from "@node-ctypes/python";

const python = await Python.initialize();
const asyncio = await python.import("asyncio");
const futures = await python.import("concurrent.futures");

console.log("═══════════════════════════════════════════════════════════");
console.log(` Python asyncio + JavaScript promises (Python ${python.version})`);
console.log("═══════════════════════════════════════════════════════════\n");

try {
  // [1] a coroutine awaited from JavaScript; Node.js keeps running meanwhile
  console.log("[1] await a Python coroutine");
  await python.exec(`
import asyncio, time

async def brew(item, seconds):
    await asyncio.sleep(seconds)
    return f"{item} ({seconds}s)"

async def breakfast():
    started = time.perf_counter()
    items = await asyncio.gather(brew("coffee", 0.3), brew("toast", 0.2), brew("eggs", 0.25))
    return {"items": items, "seconds": round(time.perf_counter() - started, 2)}
`);
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 10);
  const breakfast: PythonObject = await python.main.breakfast().finally(() => clearInterval(ticker));
  const { items, seconds } = breakfast.toJS<{ items: string[]; seconds: number }>();
  console.log(`    ${items.join(", ")} → ready in ${seconds}s, not 0.75s`);
  console.log(`    Node.js timer ticked ${ticks} times meanwhile\n`);

  // [2] Python coroutines and Node.js promises in the same Promise.all
  console.log("[2] Promise.all with Python coroutines and Node.js promises");
  const started = Date.now();
  const results = await Promise.all([
    python.main.brew("tea", 0.2), // a Python coroutine
    delay(200, "Node.js timer (0.2s)"), // a Node.js promise
    asyncio.sleep(0.2, "asyncio.sleep (0.2s)"), // an asyncio awaitable
  ]);
  console.log(`    ${results.join(" | ")} → ${Date.now() - started} ms`);

  try {
    await python.eval("asyncio.wait_for(brew('slow', 5), timeout=0.1)");
  } catch (error) {
    if (!(error instanceof PythonError) || error.type !== "TimeoutError") throw error;
    console.log(`    asyncio.wait_for timed out: PythonError ${error.type}`);
  }

  const executor = await futures.ThreadPoolExecutor();
  const numbers = await python.builtins.range(10 ** 6);
  const sum = await executor.submit(python.builtins.sum, numbers);
  console.log(`    a concurrent.futures.Future is awaitable too: sum(range(10**6)) = ${sum}\n`);
  await executor.shutdown();

  // [3] coroutines awaiting JavaScript functions
  console.log("[3] Python awaits JavaScript");
  python.module("node", {
    delay,
    read_text: (file: string) => readFile(file, "utf8"),
    version: () => process.version,
    fail: async (message: string) => {
      await delay(10);
      throw new RangeError(message);
    },
  });
  python.main.demo_file = fileURLToPath(import.meta.url);
  await python.exec(`
import node

async def describe(path):
    # JavaScript functions are awaited, concurrently with asyncio.gather
    text, version, _ = await asyncio.gather(node.read_text(path), node.version(), node.delay(100))
    return f"{len(text.splitlines())} lines read by Node {version}"

async def careful():
    try:
        await node.fail("rejected by JavaScript")
    except RuntimeError as error:
        return f"caught in Python: {error}"

async def careless():
    return await node.fail("not caught by Python")
`);
  console.log(`    ${await python.main.describe(python.main.demo_file)}`);
  console.log(`    ${await python.main.careful()}`);
  try {
    await python.main.careless();
  } catch (error) {
    if (!(error instanceof PythonError) || !(error.cause instanceof RangeError)) throw error;
    console.log(`    back in JavaScript: ${error.type}, cause ${error.cause.name}: ${error.cause.message}\n`);
  }

  // [4] the two event loops talking over TCP:
  //     Node.js fetch() → Python asyncio server → JavaScript renderer
  console.log("[4] Node.js fetch() against a Python asyncio server");
  let announce!: (port: number) => void;
  const listening = new Promise<number>((resolve) => (announce = resolve));
  python.module("web", {
    listening: (port: number) => announce(port),
    render: async (path: string) => {
      await delay(50);
      if (path === "/time") return `It is ${new Date().toISOString()} in Node.js`;
      if (path === "/numbers") return `sorted by Python: ${await python.builtins.sorted([5, 3, 8, 1])}`;
      return `Hello from JavaScript, served by Python ${python.version}`;
    },
  });
  await python.exec(`
import web

async def serve(pages):
    """HTTP server answering 'pages' requests; the pages are rendered by JavaScript."""
    served = []
    finished = asyncio.Event()

    async def handle(reader, writer):
        path = (await reader.readline()).split()[1].decode()
        while (await reader.readline()).strip():
            pass  # headers
        body = (await web.render(path)).encode()
        writer.write(b"HTTP/1.1 200 OK\\r\\nContent-Type: text/plain; charset=utf-8\\r\\n")
        writer.write(b"Content-Length: %d\\r\\nConnection: close\\r\\n\\r\\n%s" % (len(body), body))
        await writer.drain()
        writer.close()
        served.append(path)
        if len(served) == pages:
            finished.set()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    async with server:
        await web.listening(server.sockets[0].getsockname()[1])
        await asyncio.wait_for(finished.wait(), 10)
    return served
`);
  const paths = ["/hello", "/time", "/numbers"];
  const serving: Promise<PythonObject> = python.main.serve(paths.length);
  const port = await listening;
  console.log(`    Python listens on 127.0.0.1:${port}`);
  for (const path of paths) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    console.log(`    GET ${path} → ${await response.text()}`);
  }
  const served = (await serving).toJS<string[]>();
  console.log(`    the server handled ${served.length} requests\n`);

  // [5] async iteration in both directions
  console.log("[5] async iterators");
  await python.exec(`
async def countdown(n):
    """An async generator, consumed by JavaScript with for await."""
    for i in range(n, 0, -1):
        await asyncio.sleep(0.05)
        yield i

async def total(numbers):
    """async for over a JavaScript async iterable."""
    result = 0
    async for n in numbers:
        result += n
    return result
`);
  const counted: unknown[] = [];
  for await (const n of await python.main.countdown(3)) counted.push(n);
  console.log(`    for await over a Python async generator: ${counted.join(", ")}`);

  async function* readings() {
    for (const value of [3, 5, 8]) {
      await delay(20);
      yield value;
    }
  }
  console.log(`    async for in Python over a JavaScript async generator: total ${await python.main.total(readings())}\n`);

  // [6] cancellation in both directions
  console.log("[6] cancellation");
  python.module("downloads", {
    // A cancellable JavaScript function: its AbortSignal is aborted when Python cancels the call.
    download: cancellable(async (name: string, ms: number, signal: AbortSignal) => {
      signal.addEventListener("abort", () => {
        const reason: unknown = signal.reason;
        console.log(`    JavaScript: download of ${name} aborted (${reason instanceof Error ? reason.name : String(reason)})`);
      });
      await delay(ms, undefined, { signal });
      return `${name} downloaded`;
    }),
  });
  await python.exec(`
import downloads

async def patient(seconds):
    try:
        await asyncio.sleep(seconds)
        return "finished"
    except asyncio.CancelledError:
        print("    Python: patient() cancelled, cleaning up")
        raise

async def impatient():
    try:
        return await asyncio.wait_for(downloads.download("dataset", 5000), 0.1)
    except TimeoutError:
        return "gave up after 0.1 s"
`);
  try {
    await python.run(python.main.patient(10), { signal: AbortSignal.timeout(100) });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    console.log(`    JavaScript: python.run() rejected with ${error.name} after 100 ms`);
  }
  console.log(`    Python: ${await python.main.impatient()}`);

  console.log("\n    Done!");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await python.finalize();
}
