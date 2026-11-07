import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PythonError, Tuple, byReference, cancellable, kwargs } from "@node-ctypes/python";

describe("value helpers without an interpreter", () => {
  it("keeps tuple identity without changing ordinary array operations", () => {
    const tuple = Tuple.of(1, 2, 3);
    assert.ok(tuple instanceof Tuple);
    assert.deepEqual([...tuple], [1, 2, 3]);
    assert.ok(!(tuple.map((value) => value * 2) instanceof Tuple));
    assert.deepEqual(
      tuple.map((value) => value * 2),
      [2, 4, 6],
    );
    assert.ok(new Tuple() instanceof Array);
  });

  it("creates distinct markers without changing the wrapped values", () => {
    const value = { answer: 42 };
    assert.notEqual(byReference(value), value);
    assert.notEqual(kwargs(value), value);
    assert.deepEqual(value, { answer: 42 });
  });

  it("marks a cancellable function without wrapping its identity", () => {
    const operation = (value: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      return value;
    };
    assert.equal(cancellable(operation), operation);
    assert.equal(operation("ready", new AbortController().signal), "ready");
  });

  it("exports the Python exception class", () => {
    assert.ok(PythonError.prototype instanceof Error);
  });
});
