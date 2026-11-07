import assert from "node:assert/strict";
import { it } from "node:test";
import { nextCompletionToken } from "../../dist/executor.js";

it("allocates nonzero signed-int completion identifiers", () => {
  const pending = new Map<number, unknown>();
  assert.equal(nextCompletionToken(0, pending), 1);
  assert.equal(nextCompletionToken(0x7ffffffe, pending), 0x7fffffff);
});

it("wraps completion identifiers and skips every pending request", () => {
  const pending = new Map<number, unknown>([
    [1, {}],
    [2, {}],
    [0x7fffffff, {}],
  ]);
  assert.equal(nextCompletionToken(0x7ffffffe, pending), 3);
  assert.equal(nextCompletionToken(0x7fffffff, pending), 3);
  pending.delete(1);
  assert.equal(nextCompletionToken(0x7fffffff, pending), 1);
});

it("can allocate a shutdown identifier after crossing the signed-int boundary", () => {
  const pending = new Map<number, unknown>();
  let token = 0x7ffffffe;
  for (let index = 0; index < 8; index++) {
    token = nextCompletionToken(token, pending);
    pending.set(token, index);
  }
  assert.equal(pending.size, 8);
  pending.clear();
  assert.equal(nextCompletionToken(token, pending), 8);
});

it("reports a fully occupied identifier space instead of looping forever", () => {
  const pending = new Map<number, unknown>();
  Object.defineProperty(pending, "size", { value: 0x7fffffff });
  assert.throws(() => nextCompletionToken(0x7fffffff, pending), /no free completion identifiers/);
});
