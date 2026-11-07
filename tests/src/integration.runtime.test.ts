import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { EXTERNAL_BUFFERS } from "node-ctypes";
import { Python, PythonError, Tuple, byReference, kwargs } from "@node-ctypes/python";

const output: string[] = [];
const initialization = Python.initialize({ stdin: false, stdout: (text: string) => output.push(text), stderr: "node" });
assert.equal(Python.initialize(), initialization, "concurrent initialization must share one Promise");
const python = await initialization;
after(async () => await python.finalize());

describe("embedded CPython", () => {
  it("keeps source compilation and execution together before later accepted calls", async () => {
    const calls: string[] = [];
    python.module("source_order", { record: (label: string) => calls.push(label) });
    await python.exec("import source_order\ndef record_source_order(label):\n    source_order.record(label)");
    const source = python.exec("record_source_order('source')");
    const call = python.main.record_source_order("call");
    await Promise.all([source, call]);
    assert.deepEqual(calls, ["source", "call"]);
  });

  it("preserves source namespaces and compilation errors in both execution modes", async () => {
    await python.exec("source_namespace_value = 40");
    assert.equal(await python.eval("source_namespace_value + 2"), 42);
    for (const source of ["1 +", "source_namespace_value ="]) {
      const operation = source === "1 +" ? () => python.eval(source) : () => python.exec(source);
      await assert.rejects(operation, (error: unknown) => {
        assert.ok(error instanceof PythonError);
        try {
          assert.equal(error.type, "SyntaxError");
          assert.equal(error.exception.filename, "<string>");
          return true;
        } finally {
          error.exception[Symbol.dispose]();
        }
      });
    }
    assert.equal(await python.eval("source_namespace_value + 2"), 42);
  });

  it("retains one execution thread and Python thread-local state across queued calls", async () => {
    await python.exec(`
import threading
executor_local = threading.local()
def executor_probe():
    executor_local.count = getattr(executor_local, "count", 0) + 1
    return [str(threading.get_ident()), executor_local.count]
`);
    const results = await Promise.all(Array.from({ length: 64 }, () => python.main.executor_probe()));
    assert.equal(new Set(results.map(([thread]) => thread)).size, 1);
    assert.deepEqual(
      results.map(([, count]) => count),
      Array.from({ length: 64 }, (_, index) => index + 1),
    );
  });
  it("executes ordinary Python calls on the Python-owned executor while Node.js timers run", async () => {
    await python.exec("import time\ndef ordinary_work():\n    deadline = time.perf_counter() + 0.3\n    while time.perf_counter() < deadline:\n        pass\n    return 42");
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 5);
    try {
      const work = python.main.ordinary_work();
      assert.ok(work instanceof Promise);
      assert.equal(await work, 42);
      assert.ok(ticks >= 5, `Node.js must remain responsive during CPU-bound Python (${ticks} ticks)`);
    } finally {
      clearInterval(timer);
    }
    const cls = (await python.import("fractions")).Fraction;
    const constructed = await new cls(1, 2);
    try {
      assert.equal(constructed.numerator, 1);
      assert.equal(constructed.denominator, 2);
      assert.equal(constructed.toString(), "1/2");
    } finally {
      constructed[Symbol.dispose]();
    }
  });
  it("pins a disposed argument proxy until its accepted native call completes", async () => {
    await python.exec("def delayed_first(values):\n    time.sleep(0.03)\n    return values[0]");
    const values = python.toPython([42]);
    const pending = python.main.delayed_first(values);
    values[Symbol.dispose]();
    assert.equal(await pending, 42);
    assert.throws(() => values.toJS(), /released|disposed/i);
  });
  it("keeps module and instance namespaces live and synchronously enumerable", async () => {
    await python.exec("class Namespace:\n    def __init__(self):\n        self.answer = 42");
    const namespace = await python.main.Namespace();
    try {
      assert.ok(Object.keys(python.main).includes("Namespace"));
      assert.ok(Object.keys(python.builtins).includes("len"));
      assert.deepEqual(Object.keys(namespace), ["answer"]);
      assert.deepEqual(Object.entries(namespace), [["answer", 42]]);
      namespace.answer = 43;
      assert.equal(namespace.answer, 43);
      assert.equal("answer" in namespace, true);
      assert.deepEqual(Object.entries(namespace), [["answer", 43]]);
      delete namespace.answer;
      assert.equal("answer" in namespace, false);
      assert.deepEqual(Object.keys(namespace), []);
    } finally {
      namespace[Symbol.dispose]();
    }
  });
  it("exposes interpreter metadata and a singleton", async () => {
    assert.match(python.version, /^3\./);
    assert.ok(python.executable.length > 0);
    assert.ok(python.library.length > 0);
    assert.equal(await Python.initialize(), python);
    assert.equal(python.main, python.main, "main must preserve its public proxy identity");
    assert.equal(python.builtins, python.builtins, "builtins must preserve its public proxy identity");
    if (await (await python.import("sysconfig")).get_config_var("Py_GIL_DISABLED")) assert.equal(await (await python.import("sys"))._is_gil_enabled(), false);
  });

  it("executes statements and deeply converts scalar and container values", async () => {
    await python.exec("answer = 6 * 7");
    assert.equal(await python.eval("answer"), 42);
    assert.equal(await python.eval("2 ** 100"), 2n ** 100n);
    assert.equal(await python.eval("-(2 ** 100)"), -(2n ** 100n));
    assert.equal(await python.eval("'hello \\U0001f600'"), "hello \u{1f600}");
    assert.equal(await python.eval("'a\\x00b'"), "a\0b");
    python.main.unicode_text = "\u00e9\u{1f600}";
    assert.equal(await python.eval("unicode_text"), "\u00e9\u{1f600}");
    assert.deepEqual(await python.eval("b'\\x00\\x80\\xff'"), Buffer.from([0, 128, 255]));
    assert.deepEqual(await python.eval("[None, True, 1, 1.5, b'xy']"), [null, true, 1, 1.5, Buffer.from("xy")]);
    const tuple = await python.eval("(1, 'two')");
    assert.ok(tuple instanceof Tuple);
    assert.deepEqual([...tuple], [1, "two"]);
    assert.deepEqual(await python.eval("{'a': [1, 2]}"), { a: [1, 2] });
  });

  it("imports modules and supports keyword arguments", async () => {
    assert.equal(await (await python.import("math")).sqrt(81), 9);
    assert.equal(await (await python.import("json")).dumps({ b: 2, a: 1 }, kwargs({ sort_keys: true })), '{"a": 1, "b": 2}');
    assert.equal(await python.builtins.repr(Tuple.of(1, 2)), "(1, 2)");
    assert.equal(await python.builtins.sum(new Set([1, 2, 3])), 6);
    assert.equal((await python.builtins.dict(new Map([["answer", 42]]))).answer, 42);
  });

  it("rejects circular JavaScript containers with an explicit conversion error", async () => {
    const list: unknown[] = [];
    list.push(list);
    const object: Record<string, unknown> = {};
    object.self = object;
    const map = new Map<string, unknown>();
    map.set("self", map);
    const set = new Set<unknown>();
    set.add(set);
    const tuple = Tuple.of(list);
    list.push(tuple);
    for (const value of [list, object, map, set, tuple]) {
      assert.throws(
        () => python.toPython(value),
        (error: unknown) => error instanceof TypeError && /circular.*JavaScript/i.test(error.message),
      );
      assert.equal(await python.eval("6 * 7"), 42);
    }
  });

  it("rejects circular Python containers during deep conversion but preserves live proxies", async () => {
    await python.exec(`
cycle_list = []
cycle_list.append(cycle_list)
cycle_dict = {}
cycle_dict['self'] = cycle_dict
cycle_indirect = []
cycle_tuple = (cycle_indirect,)
cycle_indirect.append(cycle_tuple)
`);
    for (const name of ["cycle_list", "cycle_dict", "cycle_tuple"]) {
      await assert.rejects(
        async () => await python.eval(name),
        (error: unknown) => error instanceof TypeError && /circular.*Python/i.test(error.message),
      );
      const proxy = python.main[name];
      assert.throws(
        () => proxy.toJS(),
        (error: unknown) => error instanceof TypeError && /circular.*Python/i.test(error.message),
      );
      assert.equal(await python.builtins.len(proxy), 1);
      proxy[Symbol.dispose]();
    }
    assert.equal(await python.eval("6 * 7"), 42);
  });

  it("allows repeated non-circular values and explicitly shared circular JavaScript objects", async () => {
    const shared = { answer: [42] };
    const values = python.toPython([shared, shared]);
    try {
      assert.deepEqual(values.toJS(), [{ answer: [42] }, { answer: [42] }]);
      assert.equal((await python.builtins.id(values[0])) === (await python.builtins.id(values[1])), false);
    } finally {
      values[Symbol.dispose]();
    }
    await python.exec("shared_value = [42]\nshared_values = [shared_value, shared_value]\ndef identity(value):\n    return value");
    const copied = await python.eval<number[][]>("shared_values");
    assert.deepEqual(copied, [[42], [42]]);
    assert.notEqual(copied[0], copied[1]);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.equal(await python.main.identity(byReference(circular)), circular);
  });

  it("provides live list and dict proxies, iteration and disposal", async () => {
    const items = python.toPython([3, 1, 2]);
    await items.append(4);
    await items.sort();
    assert.equal(items.length, 4);
    assert.equal(items[-1], 4);
    assert.deepEqual([...items], [1, 2, 3, 4]);
    assert.deepEqual(items.toJS(), [1, 2, 3, 4]);
    assert.equal(JSON.stringify(items), "[1,2,3,4]");
    items[0] = 10;
    assert.equal(items[0], 10);
    const config = await (await python.import("json")).loads('{"name": "demo"}');
    config.version = 2;
    assert.equal(config.name, "demo");
    assert.ok("version" in config);
    assert.deepEqual(Object.keys(config).sort(), ["name", "version"]);
    items[Symbol.dispose]();
    assert.throws(() => items.toJS(), /released|disposed/i);
  });

  it("registers JavaScript modules, functions and submodules", async () => {
    python.module("node.tests", { add: (a: number, b: number) => a + b });
    await python.exec("from node.tests import add\ncallback_result = add(20, 22)");
    assert.equal(await python.eval("callback_result"), 42);
    assert.equal(await python.main.add(2, 3), 5);
  });

  it("imports a local Python module from a directory containing spaces", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "node-python module "));
    const sys = await python.import("sys");
    try {
      writeFileSync(path.join(directory, "node_python_fixture.py"), "def add(a, b):\n    return a + b\n");
      await sys.path.insert(0, directory);
      assert.equal(await (await python.import("node_python_fixture")).add(20, 22), 42);
    } finally {
      await sys.path.remove(directory);
      await sys.modules.pop("node_python_fixture", null);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves JavaScript references across the language boundary", async () => {
    const items = [1, 2];
    await python.exec("def change(items):\n    items.push(3)\n    return items");
    assert.equal(await python.main.change(byReference(items)), items);
    assert.deepEqual(items, [1, 2, 3]);
    class Counter {
      value = 0;
      increment() {
        return ++this.value;
      }
    }
    const counter = new Counter();
    await python.exec("def use(counter):\n    counter.increment()\n    return counter");
    assert.equal(await python.main.use(counter), counter);
    assert.equal(counter.value, 1);
  });

  it("shares typed arrays and copies exported Python buffers when external memory is unavailable", async () => {
    const values = new Float64Array([1.5, 2.5]);
    await python.exec("def scale(values):\n    for i in range(len(values)):\n        values[i] *= 2");
    await python.main.scale(values);
    assert.deepEqual([...values], [3, 5]);
    const array = await (await python.import("array")).array("i", [1, 2, 3]);
    const view = array.toTypedArray();
    assert.ok(view instanceof Int32Array);
    view[0] = 99;
    assert.equal(view[0], 99);
    assert.equal(array[0], EXTERNAL_BUFFERS ? 99 : 1);
    assert.deepEqual(python.toPython(Buffer.from([1, 2])).toJS(), Buffer.from([1, 2]));
  });

  it("converts dates and captures Python output", async () => {
    const date = new Date("2026-01-02T03:04:05.000Z");
    python.main.timestamp = date;
    assert.deepEqual(await python.eval("timestamp"), date);
    await python.exec("print('captured output')");
    assert.equal(output.join(""), "captured output\n");
  });

  it("preserves Python exceptions and JavaScript callback causes", async () => {
    await assert.rejects(
      async () => await python.eval("1 / 0"),
      (error: unknown) => {
        assert.ok(error instanceof PythonError);
        assert.equal(error.type, "ZeroDivisionError");
        assert.match(error.traceback, /ZeroDivisionError/);
        assert.ok(error.exception);
        return true;
      },
    );
    const cause = new RangeError("callback failed");
    python.module("failure", {
      fail: () => {
        throw cause;
      },
    });
    await assert.rejects(
      async () => await python.exec("import failure\nfailure.fail()"),
      (error: unknown) => error instanceof PythonError && error.cause === cause,
    );
  });

  it("supports asynchronous context managers, suppression and aborting native execution", async () => {
    const lock = await (await python.import("threading")).Lock();
    assert.equal(await python.with(lock, async () => await lock.locked()), true);
    assert.equal(await lock.locked(), false);
    const suppress = await (await python.import("contextlib")).suppress(python.builtins.ZeroDivisionError);
    assert.equal(await python.with(suppress, async () => await python.eval("1 / 0")), undefined);
    const signal = AbortSignal.timeout(100);
    await assert.rejects(
      async () => await python.run(python.exec("while True: pass"), { signal }),
      (error: unknown) => error instanceof DOMException && error.name === "TimeoutError",
    );
    assert.equal(await python.eval("40 + 2"), 42);
  });

  it("reports bridge diagnostics", () => {
    const stats = python.stats();
    assert.ok(stats && typeof stats === "object");
    for (const value of Object.values(stats)) {
      assert.equal(typeof value, "number");
      assert.ok(value >= 0);
    }
  });

  it("aborts synchronous Python once with KeyboardInterrupt, running finally blocks", async () => {
    const operation = python.exec(`
abort_log = []
spins = 0
try:
    # Body on its own line: CPython 3.12 skips the finally block when an
    # asynchronous exception interrupts a one-line "while True: ..." loop that
    # starts the try block (the backward jump is attributed outside the try).
    while True:
        spins += 1
finally:
    abort_log.append("finally")
`);
    const signal = AbortSignal.timeout(50);
    await assert.rejects(
      () => python.run(operation, { signal }),
      (error: unknown) => error === signal.reason,
    );
    await assert.rejects(operation, (error: unknown) => error instanceof PythonError && error.type === "KeyboardInterrupt");
    assert.deepEqual(await python.eval("abort_log"), ["finally"]);
    await python.exec("del abort_log, spins");
  });

  it("is not swallowed by except Exception and can be handled explicitly", async () => {
    const retry = python.exec(`
abort_retries = 0
while True:
    try:
        while True:
            pass
    except Exception:
        abort_retries += 1
`);
    await assert.rejects(() => python.run(retry, { signal: AbortSignal.timeout(30) }));
    await assert.rejects(retry, (error: unknown) => error instanceof PythonError && error.type === "KeyboardInterrupt");
    assert.equal(await python.eval("abort_retries"), 0);
    const solve = (await python.eval(`(lambda: __import__("time").sleep(0.05) or "native return")`)) as () => Promise<unknown>;
    const handled = python.exec(`
try:
    while True:
        pass
except KeyboardInterrupt:
    abort_result = "fallback"
`);
    await assert.rejects(() => python.run(handled, { signal: AbortSignal.timeout(30) }));
    await handled;
    assert.equal(await python.eval("abort_result"), "fallback");
    const native = solve();
    await assert.rejects(() => python.run(native, { signal: AbortSignal.timeout(10) }));
    await assert.rejects(native, (error: unknown) => error instanceof PythonError && error.type === "KeyboardInterrupt");
    await python.exec("del abort_retries, abort_result");
  });

  it("skips aborted queued operations and never leaks an abort into the next one", async () => {
    const busy = python.exec("import time\ntime.sleep(0.05)");
    const controller = new AbortController();
    const queued = python.exec("abort_queued = True");
    const aborted = python.run(queued, { signal: controller.signal });
    controller.abort();
    await assert.rejects(aborted);
    await assert.rejects(queued, (error: unknown) => error instanceof PythonError && error.type === "KeyboardInterrupt");
    await busy;
    assert.equal(await python.eval("'abort_queued' in globals()"), false);
    for (let i = 0; i < 200; i++) {
      const late = new AbortController();
      const done = python.run(python.eval("sum(range(1000))"), { signal: late.signal }).catch(() => undefined);
      if (i % 2) setImmediate(() => late.abort());
      else queueMicrotask(() => late.abort());
      await done;
      assert.equal(await python.eval("6 * 7"), 42);
    }
  });
});
