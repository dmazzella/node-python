// basics — run Python code and use Python modules from Node.js
//
// Embeds the installed CPython (see node-python): runs code, imports
// standard library and third-party modules, converts values between the two
// languages, and turns Python exceptions into JavaScript errors.
//
// Python calls return promises (await them); attributes, indexing and
// iteration of live Python objects are synchronous.
//
// Usage:
//   node examples/basics.ts
//   PYTHON=/path/to/venv/bin/python node examples/basics.ts

import { Python, PythonError, Tuple, kwargs, type PythonObject } from "@node-ctypes/python";

const python = await Python.initialize();

console.log("═══════════════════════════════════════════════════════════");
console.log(` Python ${python.version} embedded in Node ${process.version}`);
console.log("═══════════════════════════════════════════════════════════");
console.log(`    executable: ${python.executable}`);
console.log(`    library:    ${python.library}\n`);

const math = await python.import("math");
const statistics = await python.import("statistics");
const json = await python.import("json");
const datetime = await python.import("datetime");
const fractions = await python.import("fractions");
const collections = await python.import("collections");
const decimal = await python.import("decimal");
const threading = await python.import("threading");
const contextlib = await python.import("contextlib");
const operator = await python.import("operator");
const array = await python.import("array");
const { len, list, open, repr } = python.builtins;

// [1] exec / eval: code runs in the __main__ module
console.log("[1] exec / eval");
await python.exec(`
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
`);
const { fib } = python.main;
console.log("    fib(10) =", await fib(10));
console.log("    fib(90) =", await fib(90), "(beyond 2^53: BigInt)");
console.log("    2 ** 100 =", await python.eval("2 ** 100"));
const nested = await python.eval("{'list': [1, 2.5, None, True], 'tuple': ('é😀', b'xy')}");
console.log("    eval converts deeply:", nested);
console.log();

// [2] standard library modules
console.log("[2] standard library");
console.log("    math.sqrt(2) =", await math.sqrt(2));
console.log("    math.pi =", math.pi);
console.log("    math.factorial(25) =", await math.factorial(25));

const samples = [2.5, 3.1, 4.7, 1.2, 5.8, 3.3];
const mean: number = await statistics.mean(samples);
const median: number = await statistics.median(samples);
const stdev: number = await statistics.stdev(samples);
console.log(`    statistics: mean ${mean.toFixed(3)} | median ${median} | stdev ${stdev.toFixed(3)}`);

const compact = await json.dumps({ b: [1, 2], a: "x" }, kwargs({ sort_keys: true, separators: [",", ":"] }));
console.log("    json.dumps with kwargs:", compact);

const today = await datetime.date.today();
const weekday = await today.weekday();
console.log(`    datetime: today is ${today} (weekday ${weekday}), year ${today.year}`);

const third = await fractions.Fraction(1, 3);
const sixth = await fractions.Fraction(1, 6);
const half = await third.__add__(sixth);
console.log(`    fractions: 1/3 + 1/6 = ${half}`);

const letters = await collections.Counter("mississippi");
const mostCommon: PythonObject = await letters.most_common(2);
console.log("    Counter('mississippi').most_common(2) =", mostCommon.toJS());
console.log();

// [3] live objects: lists, dicts and instances stay in Python
console.log("[3] live objects");
const items: PythonObject = await list([3, 1, 2]);
await items.append(10);
await items.sort(kwargs({ reverse: true }));
console.log(`    list: ${items} | items[0] = ${items[0]} | items[-1] = ${items[-1]} | len = ${await len(items)}`);
console.log(
  "    iterated in JS:",
  [...items].map((n) => Number(n) * 2),
);

const config = await json.loads('{"name": "node-ctypes", "tags": ["ffi", "python"]}');
config.version = "2.0"; // dict keys are read and written as properties
console.log(`    dict: ${config}`);
console.log(`    config.name = ${config.name} | config['tags'][0] = ${config["tags"][0]} | keys:`, Object.keys(config));
console.log(`    JSON.stringify: ${JSON.stringify({ config, items })} | items.length = ${items.length}`);

const price = await decimal.Decimal("1.10");
const duration = await datetime.timedelta(kwargs({ hours: 1, minutes: 30 }));
console.log("    repr in console.log:", price, duration);

const point = await python.eval<Tuple<number>>("(3, 4)");
const hypot = await math.hypot(...point);
console.log(`    tuples: ${point instanceof Tuple ? "Tuple" : "Array"} [${point}] → math.hypot(*point) = ${hypot}, back as ${await repr(point)}`);
console.log(`    Python numbers in JavaScript arithmetic: Fraction(${half}) * 10 = ${Number(half) * 10}`);
console.log();

// [4] exceptions
console.log("[4] exceptions");
try {
  await python.eval("{'a': 1}['b']");
} catch (error) {
  if (!(error instanceof PythonError)) throw error;
  console.log(`    ${error.name}: ${error.message} (type ${error.type})`);
}

try {
  await json.loads("{not json");
} catch (error) {
  if (!(error instanceof PythonError)) throw error;
  const { msg, lineno, colno } = error.exception;
  console.log(`    ${error.type}: ${msg} at line ${lineno}, column ${colno}`);
}

await python.exec(`
def check(x):
    if x < 0:
        raise ValueError(f"negative: {x}")
    return x
`);
try {
  await python.main.check(-1);
} catch (error) {
  if (!(error instanceof PythonError)) throw error;
  console.log("    Python traceback:");
  console.log(error.traceback.replace(/^/gm, "      ").trimEnd());
}
console.log();

// [5] context managers (with) and aborting
console.log("[5] with / run(..., { signal })");
const file = await open(import.meta.filename, kwargs({ encoding: "utf-8" }));
const firstLine = await python.with(file, async (f) => (await f.readline()).trim());
console.log(`    with open(...) as file: ${firstLine}`);

const lock = await threading.Lock();
const lockedInside = await python.with(lock, async () => await lock.locked());
console.log(`    with lock: locked inside ${lockedInside}, after ${await lock.locked()}`);

const suppressDivision = await contextlib.suppress(python.builtins.ZeroDivisionError);
const division = await python.with(suppressDivision, async () => await python.eval("1 / 0"));
console.log(`    with suppress(ZeroDivisionError): 1 / 0 → ${division ?? "suppressed"}`);

const started = Date.now();
const forever = python.exec(`
try:
    while True:
        pass
except KeyboardInterrupt:
    print("    Python: KeyboardInterrupt, cleaning up")
    raise
`);
try {
  await python.run(forever, { signal: AbortSignal.timeout(200) });
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.log(`    run(while True: pass, AbortSignal.timeout(200)): ${error.name} (after ${Date.now() - started} ms)`);
}
await forever.catch(() => undefined); // the original promise rejects with KeyboardInterrupt
console.log();

// [6] dates and shared memory
console.log("[6] dates and typed arrays");
const launch = new Date(Date.UTC(2026, 9, 21, 15, 30)); // a Date is an aware datetime in Python
const delta = await datetime.timedelta(kwargs({ days: 2, hours: 3 }));
const later = await operator.add(launch, delta);
console.log(`    Date → datetime: ${await repr(launch)}`);
console.log(`    + timedelta(days=2, hours=3) → ${await later.isoformat()} → back as a Date: ${new Date(later).toISOString()}`);
const epoch = await python.eval("{'epoch': __import__('datetime').datetime(1970, 1, 1, tzinfo=__import__('datetime').timezone.utc)}");
console.log("    datetimes in eval() / toJS() are Dates:", epoch);

type TemporalGlobal = { ZonedDateTime: { from(value: string): object } };
const { Temporal } = globalThis as typeof globalThis & { Temporal?: TemporalGlobal };
if (Temporal) {
  const meeting = Temporal.ZonedDateTime.from("2026-10-21T15:30[Europe/Rome]");
  console.log(`    Temporal: ${meeting} → ${await repr(meeting)}`);
  const values = await python.eval<unknown[]>("[__import__('datetime').date(2026, 10, 21), __import__('datetime').timedelta(hours=1, minutes=30)]");
  console.log("    date and timedelta in eval() → Temporal:", values.map(String));
} else {
  console.log("    Temporal is not available in this Node.js runtime: skipped");
}

await python.exec(`
def scale(values, factor):
    for i in range(len(values)):
        values[i] *= factor
`);
const measurements = new Float64Array([2.5, 3.1, 4.7]);
const view = python.toPython(measurements); // a memoryview of the same memory, no copy
await python.main.scale(view, 10);
console.log(`    Float64Array as memoryview (format ${view.format}): scaled in place by Python → ${Array.from(measurements)}`);

const shared = await array.array("i", [1, 2, 3]);
const int32 = shared.toTypedArray(); // the memory of the Python array
int32[0] = 100;
console.log(`    array('i').toTypedArray() → ${int32.constructor.name}, written by JavaScript: ${shared}`);
console.log();

// [7] third-party packages, if installed in the interpreter's environment
console.log("[7] third-party packages");
let np: PythonObject | undefined;
try {
  np = await python.import("numpy");
} catch (error) {
  if (!(error instanceof PythonError) || error.type !== "ModuleNotFoundError" || error.exception.name !== "numpy") throw error;
  console.log(`    numpy is not installed for Python ${python.version} (${python.executable}): skipped`);
  console.log("    Install it with this interpreter using -m pip install numpy, or set PYTHON to the interpreter where it is installed.");
  error.exception[Symbol.dispose]();
}
if (np) {
  const range = await np.arange(12);
  const matrix = await range.reshape(3, 4);
  console.log(`    numpy ${np.__version__}:`);
  console.log(String(matrix).replace(/^/gm, "      "));

  const means = await matrix.mean(kwargs({ axis: 0 }));
  const total = await matrix.sum();
  console.log("    column means:", (await means.tolist()).toJS(), "| sum:", await total.item());

  // Shared memory both ways: numpy over a Float32Array, a numpy array as a Float64Array.
  const signal = new Float32Array([0.5, 1.5, 2.5, 3.5]);
  const overSignal = await np.asarray(signal);
  await overSignal.__imul__(2);
  console.log(`    numpy doubled a Float32Array in place: ${Array.from(signal)}`);

  const ones = await np.ones(4);
  ones.toTypedArray()[0] = 42;
  console.log(`    a numpy array written through a Float64Array: ${ones}`);
}

console.log("\n    Done!");
