import assert from "node:assert/strict";
import { setImmediate as immediate } from "node:timers/promises";
import { Python } from "@node-ctypes/python";
import { PythonLibrary } from "../../dist/native.js";
import { loadLibrary, probeInterpreter } from "../../dist/interpreter.js";

assert.ok(global.gc, "this fixture requires --expose-gc");
const loaded = loadLibrary(await probeInterpreter());
const ensure = loaded.lib.PyGILState_Ensure;
const descriptor = Object.getOwnPropertyDescriptor(PythonLibrary.prototype, "PyGILState_Ensure");
let measuring = false;
let acquisitions = 0;
Object.defineProperty(PythonLibrary.prototype, "PyGILState_Ensure", {
  configurable: true,
  value() {
    if (measuring) acquisitions++;
    return ensure();
  },
});

let python: Python | undefined;
try {
  python = await Python.initialize({ stdin: false });
  let releases = 0;
  python.main.release_marker = () => releases++;
  await python.exec(`
import time
class Collected:
    def __del__(self):
        release_marker()
def ordinary_work():
    deadline = time.perf_counter() + 0.3
    while time.perf_counter() < deadline:
        pass
    return 42
`);
  const create = python.main.Collected;
  const work = python.main.ordinary_work;
  const garbage = await Promise.all(Array.from({ length: 128 }, () => create()));
  const before = python.stats().proxies;
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    measuring = true;
    const pending = work();
    garbage.length = 0;
    setImmediate(() => global.gc!());
    assert.equal(await pending, 42);
  } finally {
    measuring = false;
    clearInterval(timer);
  }
  const collected = before - python.stats().proxies;
  assert.ok(collected >= 128, `the regression must collect its Python proxies (${collected})`);
  assert.equal(releases, 128, "collected references must run their Python destructors and JavaScript callbacks");
  assert.ok(acquisitions < collected / 2, `automatic release must batch GIL acquisition (${acquisitions} acquisitions for ${collected} proxies)`);
  assert.ok(ticks >= 5, `Node.js timers must run during Python execution and proxy collection (${ticks} ticks)`);
  const freeThreaded = await python.eval<boolean>('__import__("sysconfig").get_config_var("Py_GIL_DISABLED") == 1');
  const explicit = await create();
  explicit[Symbol.dispose]();
  // Free-threaded CPython defers deallocation to the creating thread (here the
  // executor) when the last reference is dropped elsewhere (biased reference
  // counting); that thread merges it the next time it runs Python code.
  if (freeThreaded) {
    for (const deadline = Date.now() + 5000; releases < 129 && Date.now() < deadline; ) {
      await python.eval("None");
      await immediate();
    }
  }
  assert.equal(releases, 129, "explicit disposal must still release its reference synchronously");
  await immediate();
  assert.equal(await python.eval("6 * 7"), 42);
} finally {
  try {
    await python?.finalize();
  } finally {
    if (descriptor) Object.defineProperty(PythonLibrary.prototype, "PyGILState_Ensure", descriptor);
    else Reflect.deleteProperty(PythonLibrary.prototype, "PyGILState_Ensure");
    loaded.lib.close();
    loaded.release?.();
  }
}
