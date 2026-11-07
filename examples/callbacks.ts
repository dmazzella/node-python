// callbacks — JavaScript functions called by Python
//
// Exposes JavaScript functions to the embedded Python as an importable module
// and as callbacks (key functions, reducers, event handlers), with errors and
// recursion crossing the two languages, and JavaScript objects used by Python
// by reference.
//
// Usage:
//   node examples/callbacks.ts

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Python, PythonError, byReference, kwargs, type PythonObject } from "@node-ctypes/python";

const python = await Python.initialize();
const events = new EventEmitter();
const { filter, list, map, range, sorted } = python.builtins;

console.log("═══════════════════════════════════════════════════════════");
console.log(` JavaScript ↔ Python callbacks (Python ${python.version})`);
console.log("═══════════════════════════════════════════════════════════\n");

// [1] a module written in JavaScript, imported by Python code
console.log("[1] import node (a JavaScript module)");
python.module("node", {
  version: process.version,
  platform: process.platform,
  read_text: (file: string) => readFileSync(file, "utf8"),
  sha256: (text: string) => createHash("sha256").update(text).digest("hex"),
  // A Python callable kept by JavaScript and called from the event loop.
  on: (event: string, handler: PythonObject) => {
    events.on(event, async (...args: unknown[]) => await handler(...args));
  },
});
python.main.demo_file = fileURLToPath(import.meta.url);
await python.exec(`
import node
print(f"    Python sees Node {node.version} on {node.platform}")
print(f"    node.sha256('hello') = {node.sha256('hello')[:16]}...")
lines = node.read_text(demo_file).splitlines()
print(f"    this demo has {len(lines)} lines, the first: {lines[0]!r}")
`);
console.log();

// [2] JavaScript functions as Python callbacks
console.log("[2] callbacks");
const functools = await python.import("functools");
const re = await python.import("re");

const words = ["kiwi", "banana", "fig", "cherry", "apple"];
const byLength: PythonObject = await sorted(words, kwargs({ key: (word: string) => word.length, reverse: true }));
console.log("    sorted(key=len, reverse) =", byLength.toJS());

const product = await functools.reduce((a: number, b: number) => a * b, await range(1, 11));
console.log("    reduce(×, 1..10) =", product);

const doubled = await re.sub("\\d+", (match: PythonObject) => String(Number(match[0]) * 2), "3 apples and 12 pears");
console.log("    re.sub(doubling) =", doubled);

const squares = await map((n: number) => n * n, await range(10));
const multiplesOfThree = await filter((n: number) => n % 3 === 0, squares);
const selected: PythonObject = await list(multiplesOfThree);
console.log("    map + filter:", selected.toJS());
console.log();

// [3] recursion across the languages: is_even in JavaScript, is_odd in Python
console.log("[3] mutual recursion JavaScript ↔ Python");
python.module("parity", {
  is_even: async (n: number): Promise<boolean> => (n === 0 ? true : await python.main.is_odd(n - 1)),
});
await python.exec(`
import parity

async def is_odd(n):
    return False if n == 0 else await parity.is_even(n - 1)
`);
const { is_odd } = python.main;
console.log(`    is_odd(7) = ${await is_odd(7)}, is_odd(10) = ${await is_odd(10)} (each step crosses the boundary)`);
console.log();

// [4] errors in both directions
console.log("[4] errors");
await python.exec(`
import node
try:
    node.read_text("/does/not/exist")
except RuntimeError as e:
    print("    Python caught:", e)

async def call_with(f, x):
    return await f(x)
`);
const { call_with } = python.main;
try {
  // A KeyError raised by Python inside a JavaScript callback keeps its type.
  await call_with(async (key: string) => await python.eval(`{}[${JSON.stringify(key)}]`), "missing");
} catch (error) {
  if (!(error instanceof PythonError)) throw error;
  console.log(`    JavaScript caught ${error.message} (JavaScript → Python → JavaScript, type kept)`);
}
try {
  const reject = () => {
    throw new TypeError("bad input");
  };
  await call_with(reject, 1);
} catch (error) {
  if (!(error instanceof PythonError) || !(error.cause instanceof TypeError)) throw error;
  console.log(`    JavaScript caught ${error.message}; error.cause is the original ${error.cause.name}`);
}
console.log();

// [5] JavaScript objects used by Python by reference
console.log("[5] JavaScript objects in Python");
class Cart {
  items: { name: string; price: number }[] = [];
  add(name: string, price: number) {
    this.items.push({ name, price });
    return this;
  }
  get total() {
    return this.items.reduce((sum, item) => sum + item.price, 0);
  }
}
python.module("shop", { Cart, EventEmitter });
await python.exec(`
import shop

def fill(cart):
    cart.add("book", 12.5).add("pen", 1.5)  # methods, chained: the same JavaScript object
    cart.items[0]["price"] = 10              # nested objects are used by reference too
    return len(cart.items), cart.total
`);
const cart = new Cart();
const [count, total] = await python.main.fill(cart);
console.log(`    Python filled the cart (${count} items, total ${total}); JavaScript sees ${JSON.stringify(cart.items)}`);
console.log(`    Python creates JavaScript objects: ${await python.eval("repr(shop.Cart().add('mug', 8))")}`);

const settings = new Map([["theme", "dark"]]);
python.main.settings = byReference(settings); // by value it would be a dict copy
await python.exec(`
settings["lang"] = "it"
del settings["theme"]
`);
console.log("    byReference(Map) changed by Python:", settings);

await python.exec(`
emitter = shop.EventEmitter.new()  # .new(): constructors that are not classes
heard = []
emitter.on("hello", heard.append)

async def emit_hello():
    # Awaited from a coroutine, so JavaScript can call the Python listener.
    await emitter.emit("hello", "from Python")
`);
await python.main.emit_hello();
console.log("    Node.js EventEmitter created and used by Python:", await python.eval("heard"));
console.log();

// [6] Python handlers for Node.js events
console.log("[6] Python event handlers (Node.js event loop)");
await python.exec(`
import node
received = []

def on_tick(n, payload):
    received.append(n)
    print(f"    Python handler: tick {n}, payload {payload}")

node.on("tick", on_tick)
`);
let tick = 0;
const timer = setInterval(async () => {
  tick++;
  events.emit("tick", tick, { source: "setInterval", at: Date.now() % 100000 });
  if (tick < 3) return;
  clearInterval(timer);
  const received = await python.eval<number[]>("received");
  console.log(`    Python received ticks ${received.join(", ")}`);
  console.log("\n    Done!");
}, 100);

process.on("uncaughtException", (error) => {
  console.error(error instanceof PythonError ? `${error.message}\n${error.traceback}` : error);
  process.exit(1);
});
