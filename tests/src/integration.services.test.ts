import assert from "node:assert/strict";
import { after, it, mock } from "node:test";
import { Python, PythonError, byReference } from "@node-ctypes/python";
import { PythonConversions } from "../../dist/conversions.js";

const python = await Python.initialize({ stdin: false });
after(async () => await python.finalize());
// Public callable proxies cannot drive the service's synchronous internal helpers.
const conversions = (() => {
  let service: PythonConversions | undefined;
  const original = PythonConversions.prototype.fromTimestamp;
  const capture = mock.method(PythonConversions.prototype, "fromTimestamp", function (this: PythonConversions, milliseconds: number) {
    service = this;
    return original.call(this, milliseconds);
  });
  try {
    using marker = python.toPython(new Date(0));
    assert.deepEqual(marker.toJS(), new Date(0));
  } finally {
    capture.mock.restore();
  }
  assert.ok(service, "date conversion must use the runtime's synchronous internal conversion service");
  return service;
})();

it("always uses native object protocols and callable factories", async () => {
  python.main.native_shared = byReference({ answer: 42 });
  python.main.native_callable = () => 42;
  assert.equal(
    await python.eval(`(__import__("inspect").isbuiltin(native_shared.__dir__)
      and type(native_shared) is __import__("_node_ctypes").NativeJsProxy
      and __import__("inspect").isbuiltin(native_callable.__globals__["_js"])
      and not hasattr(__import__("_node_ctypes"), "_js_async")
      and "__getattr__" not in vars(__import__("_node_ctypes").JsProxy))`),
    true,
  );
  assert.equal(await python.eval("native_shared.answer + native_callable()"), 84);
  assert.equal(await python.eval('len(__import__("_node_ctypes")._native_dispatchers)'), 0);
});

it("constructs modular adapters without the legacy bridge helper surface", async () => {
  assert.equal(
    await python.eval(`all(not hasattr(__import__("_node_ctypes"), name) for name in (
    "take_released", "track_native", "get_fallback", "set_fallback", "delete_fallback",
    "keys", "to_primitive", "memory", "export_buffer", "from_timestamp", "timestamp",
    "to_js_value", "from_temporal", "submit", "open_channel", "take_request", "settle",
    "shutdown", "redirect", "Watchdog", "format_exception"
  ))`),
    true,
  );
  assert.equal(await python.eval('__import__("_node_ctypes").wrap.__code__.co_filename'), "<node-python callables>");
});

it("preserves mapping fallback, exact string keys and numeric coercion", async () => {
  await python.exec(`
from collections import UserDict
from decimal import Decimal
from fractions import Fraction
class StringKey(str): pass
service_mapping = UserDict({"length": 9, "value": 42, StringKey("subclass"): 1, 3: 4})
service_decimal = Decimal("1.25")
service_fraction = Fraction(3, 2)
service_complex = complex(1, 2)
`);
  const mapping = python.main.service_mapping;
  assert.equal(mapping.length, 9);
  assert.equal(mapping.value, 42);
  assert.deepEqual(Object.keys(mapping).sort(), ["length", "value"]);
  delete mapping.length;
  assert.equal(mapping.length, 3);
  assert.equal(+python.main.service_decimal, 1.25);
  assert.equal(+python.main.service_fraction, 1.5);
  assert.equal(String(python.main.service_complex), "(1+2j)");
});

it("preserves naive datetime coercion and explicit Temporal field conversions", async () => {
  const datetime = await python.import("datetime");
  python.main.service_naive_date = await datetime.datetime(2026, 1, 2, 3, 4, 5);
  const value = python.main.service_naive_date;
  assert.equal(+value, await python.eval("service_naive_date.astimezone().timestamp() * 1000"));
  const date = conversions.fromTemporal(["date", 2026, 1, 2]);
  const time = conversions.fromTemporal(["time", 3, 4, 5, 123456]);
  const duration = conversions.fromTemporal(["duration", -86_400_001_002n]);
  const zoned = conversions.fromTemporal(["zoned", 0n, "Missing/Imaginary", 3_600_000_000n]);
  try {
    assert.deepEqual(conversions.toJSValue(date, true), ["PlainDate", 2026, 1, 2]);
    assert.deepEqual(conversions.toJSValue(time, true), ["PlainTime", 3, 4, 5, 123456]);
    assert.deepEqual(conversions.toJSValue(duration, true), ["Duration", -1, 0, 0, 0, -1, -2]);
    assert.equal(zoned.isoformat(), "1970-01-01T01:00:00+01:00");
    const huge = conversions.fromTemporal(["duration", -999999999n * 86_400_000_000n]);
    try {
      assert.deepEqual(conversions.toJSValue(huge, true), ["Duration", -999999999, 0, 0, 0, 0, 0]);
    } finally {
      huge[Symbol.dispose]();
    }
  } finally {
    for (const object of [date, time, duration, zoned, value]) object[Symbol.dispose]();
  }
});

// Temporal is a Node.js 26+ global; CI runs both Node.js 24 and 26.
const Temporal = (globalThis as { Temporal?: any }).Temporal;
it("converts Temporal values end to end in both directions", { skip: !Temporal && "Temporal requires Node.js 26+" }, async () => {
  python.main.service_plain_date = new Temporal.PlainDate(2026, 10, 21);
  python.main.service_plain_time = new Temporal.PlainTime(3, 4, 5, 123, 456);
  python.main.service_plain_datetime = Temporal.PlainDateTime.from("2026-10-21T10:20:30.000001");
  python.main.service_instant = Temporal.Instant.fromEpochMilliseconds(0);
  python.main.service_zoned = Temporal.ZonedDateTime.from("2026-10-21T10:00:00[Europe/Rome]");
  python.main.service_duration = Temporal.Duration.from({ hours: 1, minutes: 30, microseconds: 7 });
  assert.deepEqual(
    await python.eval<string[]>(`[
      repr(service_plain_date), repr(service_plain_time), repr(service_plain_datetime),
      service_instant.isoformat(), service_zoned.isoformat(), repr(service_duration)]`),
    ["datetime.date(2026, 10, 21)", "datetime.time(3, 4, 5, 123456)", "datetime.datetime(2026, 10, 21, 10, 20, 30, 1)", "1970-01-01T00:00:00+00:00", "2026-10-21T10:00:00+02:00", "datetime.timedelta(seconds=5400, microseconds=7)"],
  );
  const [date, time, duration, instant] = await python.eval<any[]>("[service_plain_date, service_plain_time, service_duration, service_instant]");
  assert.ok(date instanceof Temporal.PlainDate && date.equals(new Temporal.PlainDate(2026, 10, 21)));
  assert.ok(time instanceof Temporal.PlainTime && time.equals(new Temporal.PlainTime(3, 4, 5, 123, 456)));
  assert.ok(duration instanceof Temporal.Duration);
  assert.equal(duration.toString(), "PT1H30M0.000007S");
  assert.deepEqual(instant, new Date(0), "aware datetimes return through the Date path");
  assert.throws(() => (python.main.service_years = Temporal.Duration.from({ years: 1 })), /years or months/);
});

it("preserves read-only, empty, noncontiguous and shared buffer behavior", async () => {
  await python.exec("service_readonly = memoryview(bytes([1, 2, 3]))");
  const readonly = python.main.service_readonly;
  const copied = readonly.toTypedArray();
  copied[0] = 9;
  assert.equal(readonly[0], 1);
  const view = python.toPython(Buffer.from([1, 2, 3]));
  assert.deepEqual([...view.toTypedArray()], [1, 2, 3]);
  const empty = python.toPython(new Int16Array());
  assert.equal(empty.toTypedArray().length, 0);
  await python.exec("service_buffer = memoryview(bytearray([1, 2, 3, 4]))[::2]");
  assert.throws(
    () => python.main.service_buffer.toTypedArray(),
    (error: unknown) => {
      if (!(error instanceof PythonError)) return false;
      try {
        return error.type === "BufferError" && /C-contiguous/.test(error.message);
      } finally {
        error.exception[Symbol.dispose]();
      }
    },
  );
  const values = new Int32Array([1, 2]);
  const shared = python.toPython(values);
  shared[0] = 42;
  assert.equal(values[0], 42);
  for (const object of [readonly, view, empty, shared]) object[Symbol.dispose]();
});

it("does not retain an exception traceback after its PythonError is disposed", async () => {
  python.main.traceback_value = byReference({ answer: 42 });
  await python.exec(`
import weakref, gc
traceback_weak = weakref.ref(traceback_value)
def traceback_failure(value):
    raise ValueError("temporary traceback")
`);
  await assert.rejects(
    async () => await python.exec("traceback_failure(traceback_value)"),
    (error: unknown) => {
      if (!(error instanceof PythonError)) return false;
      try {
        return error.type === "ValueError" && error.traceback.includes("traceback_failure");
      } finally {
        error.exception[Symbol.dispose]();
      }
    },
  );
  await python.exec("del traceback_value\ngc.collect()");
  assert.equal(await python.eval("traceback_weak() is None"), true);
});
