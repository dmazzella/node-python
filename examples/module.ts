// module — import a local .py module and use its classes from Node.js
//
// inventory.py (next to this demo) is a plain Python module: its directory is
// added to sys.path, then classes, properties, generators, custom exceptions
// and callbacks are used from JavaScript.
//
// Usage:
//   node examples/module.ts

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Python, PythonError, kwargs, type PythonObject } from "@node-ctypes/python";

const python = await Python.initialize();

console.log("═══════════════════════════════════════════════════════════");
console.log(` Local Python module: inventory.py (Python ${python.version})`);
console.log("═══════════════════════════════════════════════════════════\n");

// [1] import inventory.py from this demo's directory (Python: sys.path.insert)
const sys = await python.import("sys");
await sys.path.insert(0, dirname(fileURLToPath(import.meta.url)));
const inventory = await python.import("inventory");
console.log("[1] import inventory");
console.log(`    ${inventory}`);
console.log(`    docstring: ${inventory.__doc__.split("\n")[0]}`);
console.log();

// [2] create an instance and call its methods (positional and keyword arguments)
const shop: PythonObject = await inventory.Inventory("node-ctypes shop");
await shop.add("keyboard", 49.9, 3);
await shop.add("mouse", 19.5, kwargs({ quantity: 10 }));
await shop.add("monitor", 189.0);
const cable = await shop.add("cable", 4.25, 2);
console.log("[2] Inventory instance");
console.log(`    ${shop}`); // __repr__
console.log(`    len = ${await python.builtins.len(shop)}, owner = ${shop.owner}, total value = ${await shop.total_value()}`);
console.log(`    returned dataclass: ${cable}, property total = ${cable.total}`);
console.log();

// [3] iterate Python objects from JavaScript: __iter__ and a generator
console.log("[3] iteration");
for (const value of shop) {
  const { name, quantity, price, total } = value as PythonObject;
  console.log(`    ${name.padEnd(9)} ${String(quantity).padStart(3)} × ${price.toFixed(2).padStart(7)} = ${total.toFixed(2).padStart(8)}`);
}
const lowStock: PythonObject = await shop.low_stock(kwargs({ threshold: 2 }));
console.log(`    low stock (generator): ${[...lowStock].join(", ")}`);
console.log();

// [4] attribute writes and JSON for JavaScript
cable.price = 3.99;
console.log("[4] attribute write and JSON");
console.log(`    cable.price = 3.99 → cable.total = ${cable.total}`);
const data = JSON.parse(await shop.to_json()) as { items: { name: string; price: number; quantity: number }[] };
console.log(`    to_json() → JSON.parse: ${data.items.length} items, first ${JSON.stringify(data.items[0])}`);
console.log("    items dict → toJS():", Object.keys(shop.items.toJS()));
console.log();

// [5] custom Python exception, with its attributes
console.log("[5] custom exception");
try {
  await shop.remove("monitor", 5);
} catch (error) {
  if (!(error instanceof PythonError) || error.type !== "OutOfStock") throw error;
  const { name, requested, available } = error.exception;
  console.log(`    ${error.message}`);
  console.log(`    attributes: name=${name}, requested=${requested}, available=${available}`);
}
console.log();

// [6] a JavaScript function as the callback of a Python method. The dict it
// receives is a live Python object: item.get("name"), or toJS() for a JS object.
console.log("[6] JavaScript formatter passed to report()");
const lines: PythonObject = await shop.report((item: PythonObject) => {
  const { name, quantity, price } = item.toJS<{ name: string; quantity: number; price: number }>();
  return `${name.toUpperCase()}: ${quantity} pcs @ ${price.toFixed(2)} EUR`;
});
for (const line of lines) console.log(`    ${line}`);

console.log("\n    Done!");
