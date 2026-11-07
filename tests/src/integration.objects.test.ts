import assert from "node:assert/strict";
import { after, it } from "node:test";
import { Python, PythonError, byReference, kwargs } from "@node-ctypes/python";

const python = await Python.initialize({ stdin: false });
after(async () => await python.finalize());

async function raises(code: string, type: string, cause?: unknown): Promise<void> {
  await assert.rejects(
    async () => await python.exec(code),
    (error: unknown) => {
      if (!(error instanceof PythonError)) return false;
      try {
        assert.equal(error.type, type);
        if (cause !== undefined) assert.equal(error.cause, cause);
        return true;
      } finally {
        error.exception[Symbol.dispose]();
      }
    },
  );
}

it("preserves shared identity, bound methods, nested references and attribute operations", async () => {
  const child = { value: 1 };
  class Shared {
    value = 2;
    child = child;
    add(amount: number) {
      return (this.value += amount);
    }
  }
  const shared = new Shared();
  python.main.shared = shared;
  python.main.same = shared;
  assert.equal(await python.eval("shared == same and hash(shared) == hash(same)"), true);
  assert.equal(await python.eval("shared.add(3)"), 5);
  assert.equal(await python.eval("shared"), shared);
  assert.equal(await python.eval("shared.child"), child);
  await python.exec("shared.value = 7\nshared.child.value = 8");
  assert.equal(shared.value, 7);
  assert.equal(child.value, 8);
  await python.exec("shared.extra = 9\ndel shared.extra");
  assert.equal("extra" in shared, false);
  await raises("shared.missing", "AttributeError");
  await raises("del shared.missing", "AttributeError");
  await raises("shared.__missing_protocol__", "AttributeError");
});

it("preserves item mutation, membership, indexing, truth and iteration", async () => {
  const list = [1, 2];
  const map = new Map<string, number>([["a", 3]]);
  const record = { a: 4 };
  python.main.shared_list = byReference(list);
  python.main.shared_map = byReference(map);
  python.main.shared_record = byReference(record);
  assert.deepEqual(await python.eval("[len(shared_list), shared_list[-1], 2 in shared_list, bool(shared_list), list(shared_map), list(shared_record)]"), [2, 2, true, true, ["a"], ["a"]]);
  await python.exec("shared_list[2] = 3\ndel shared_list[0]\nshared_map['b'] = 5\ndel shared_map['a']\nshared_record['b'] = 6\ndel shared_record['a']");
  assert.deepEqual(list, [2, 3]);
  assert.deepEqual([...map], [["b", 5]]);
  assert.deepEqual(record, { b: 6 });
  await raises("shared_list[100]", "IndexError");
  await raises("shared_map['missing']", "KeyError");
  await raises("del shared_map['missing']", "KeyError");
  await raises("len(shared_record)", "TypeError");
  await python.exec("del shared_list[0]\ndel shared_list[0]");
  assert.equal(await python.eval("bool(shared_list)"), false);
});

it("preserves representation, dir, weakrefs and GC tracking", async () => {
  python.main.shared_text = byReference({ value: 42 });
  assert.equal(await python.eval("str(shared_text)"), "[object Object]");
  assert.equal(await python.eval("repr(shared_text)"), "{ value: 42 }");
  assert.equal(await python.eval("'value' in dir(shared_text)"), true);
  assert.equal(await python.eval("__import__('gc').is_tracked(shared_text)"), true);
  await python.exec("import weakref\nshared_weak = weakref.ref(shared_text)");
  assert.equal(await python.eval("shared_weak() == shared_text"), true);
  await python.exec("del shared_text\nimport gc\ngc.collect()");
  assert.equal(await python.eval("shared_weak() is None"), true);
});

it("preserves length errors rather than truncating or wrapping invalid sizes", async () => {
  for (const [length, expected] of [
    [-1, "ValueError"],
    [1.5, "TypeError"],
    [2 ** 100, "OverflowError"],
  ] as const) {
    python.main.bad_length = byReference({ length });
    await raises("len(bad_length)", expected);
  }
});

it("preserves getter error causes and reentrant access", async () => {
  const failure = new RangeError("shared getter failed");
  python.main.shared_errors = byReference({
    answer: 42,
    get nested() {
      return python.main.shared_errors.answer + 1;
    },
    get broken() {
      throw failure;
    },
  });
  assert.equal(await python.eval("shared_errors.nested"), 43);
  await raises("shared_errors.broken", "RuntimeError", failure);
  assert.equal(await python.eval("shared_errors.answer"), 42);
});

it("serves shared-object protocols from foreign Python threads", async () => {
  const values = [10, 20, 30];
  python.main.foreign_values = byReference(values);
  await python.exec("def shared_thread(index):\n    return foreign_values[index] + len(foreign_values)");
  const pool = await (await python.import("concurrent.futures")).ThreadPoolExecutor(kwargs({ max_workers: 8 }));
  try {
    const results = await Promise.all(Array.from({ length: 32 }, async (_, index) => Promise.resolve(pool.submit(python.main.shared_thread, index % 3))));
    assert.deepEqual(
      results,
      Array.from({ length: 32 }, (_, index) => values[index % 3] + 3),
    );
  } finally {
    await pool.shutdown();
  }
});

it("awaits a shared JavaScript promise through the existing async protocol", async () => {
  python.main.shared_promise = Promise.resolve(42);
  await python.exec("async def shared_await():\n    return await shared_promise");
  assert.equal(await python.main.shared_await(), 42);
});

it("preserves identity hashes, inequality and reflected ordering", async () => {
  const value = { answer: 42 };
  python.main.compared = byReference(value);
  python.main.compared_same = byReference(value);
  python.main.compared_other = byReference({ answer: 42 });
  assert.deepEqual(await python.eval("[compared == compared_same, compared != compared_same, compared == compared_other, compared != compared_other, compared == None, compared != None]"), [true, false, false, true, false, true]);
  assert.equal(await python.eval("hash(compared) == hash(compared._id) == hash(compared_same)"), true);
  assert.equal(await python.eval("len({compared, compared_same, compared_other})"), 2);
  for (const operator of ["<", "<=", ">", ">="]) await raises(`compared ${operator} compared_other`, "TypeError");
  await python.exec(`
class ReflectedOrdering:
    def __gt__(self, other): return "gt"
    def __ge__(self, other): return "ge"
    def __lt__(self, other): return "lt"
    def __le__(self, other): return "le"
reflected_order = ReflectedOrdering()
`);
  assert.deepEqual(await python.eval("[compared < reflected_order, compared <= reflected_order, compared > reflected_order, compared >= reflected_order]"), ["gt", "ge", "lt", "le"]);
  assert.equal(await python.eval("compared.__lt__(compared_other) is NotImplemented"), true);
});

it("lists inherited JavaScript names without reading getters and preserves dir failures", async () => {
  let getterCalls = 0;
  const value = Object.create({ inherited: 1 });
  Object.defineProperties(value, {
    z: { value: 1 },
    a: {
      get() {
        getterCalls++;
        return 2;
      },
    },
  });
  python.main.directory_value = byReference(value);
  assert.deepEqual(await python.eval("dir(directory_value)"), ["a", "inherited", "z"]);
  assert.deepEqual(await python.eval("sorted(directory_value.__dir__())"), ["a", "inherited", "z"]);
  await raises("directory_value.__dir__(1)", "TypeError");
  assert.equal(getterCalls, 0);
  const failure = new RangeError("ownKeys failed");
  python.main.directory_failure = byReference(
    new Proxy(
      {},
      {
        ownKeys() {
          throw failure;
        },
      },
    ),
  );
  await raises("dir(directory_failure)", "RuntimeError", failure);
});

it("serves dir, hash and comparisons from foreign Python threads", async () => {
  const value = { answer: 42 };
  python.main.thread_protocol = byReference(value);
  python.main.thread_protocol_same = byReference(value);
  await python.exec(`
def thread_protocol_read():
    return (dir(thread_protocol), hash(thread_protocol) == hash(thread_protocol_same),
            thread_protocol == thread_protocol_same, thread_protocol != thread_protocol_same)
`);
  const pool = await (await python.import("concurrent.futures")).ThreadPoolExecutor(kwargs({ max_workers: 8 }));
  try {
    const results = await Promise.all(Array.from({ length: 32 }, async () => Promise.resolve(pool.submit(python.main.thread_protocol_read))));
    for (const result of results) {
      try {
        assert.deepEqual([...result.toJS()], [["answer"], true, true, false]);
      } finally {
        result[Symbol.dispose]();
      }
    }
  } finally {
    await pool.shutdown();
  }
});

it("preserves Python ID comparison order, truth conversion and hash errors", async () => {
  python.main.protocol_left = byReference({});
  python.main.protocol_right = byReference({});
  await python.exec(`
def check_id_protocols():
    import _node_ctypes
    descriptor = _node_ctypes.JsProxy._id
    saved = (protocol_left._id, protocol_right._id)
    class Identifier:
        def __init__(self, name):
            self.name = name
        def __eq__(self, other):
            return ("equal", self.name)
        def __ne__(self, other):
            raise AssertionError("ID inequality must not be used")
        def __hash__(self):
            return -1
    class InvalidTruth:
        def __bool__(self):
            raise ValueError("ID truth failed")
    class InvalidComparison(Identifier):
        def __eq__(self, other):
            return InvalidTruth()
    try:
        descriptor.__set__(protocol_left, Identifier("left"))
        descriptor.__set__(protocol_right, Identifier("right"))
        assert (protocol_left == protocol_right) == ("equal", "right")
        assert (protocol_left != protocol_right) is False
        assert hash(protocol_left) == -2
        descriptor.__set__(protocol_right, InvalidComparison("right"))
        try:
            protocol_left != protocol_right
        except ValueError as error:
            assert str(error) == "ID truth failed"
        else:
            raise AssertionError("truth error was lost")
        descriptor.__set__(protocol_left, [])
        try:
            hash(protocol_left)
        except TypeError:
            pass
        else:
            raise AssertionError("hash error was lost")
    finally:
        descriptor.__set__(protocol_left, saved[0])
        descriptor.__set__(protocol_right, saved[1])
check_id_protocols()
del check_id_protocols
`);
});

it("releases shared aliases collected by Python workers without forgetting surviving wrappers", async () => {
  const drain = () => {
    const callable = python.toPython(() => null);
    callable[Symbol.dispose]();
  };
  await python.exec("import gc, weakref\ngc.collect()");
  drain();
  const before = python.stats().objects;
  const value = { answer: 42 };
  python.main.release_first = byReference(value);
  python.main.release_second = byReference(value);
  await python.exec(`
release_weak = [weakref.ref(release_first), weakref.ref(release_second)]
def release_alias(name):
    del globals()[name]
    gc.collect()
    return True
`);
  const pool = await (await python.import("concurrent.futures")).ThreadPoolExecutor(kwargs({ max_workers: 1 }));
  try {
    assert.equal(await pool.submit(python.main.release_alias, "release_first"), true);
    assert.equal(await python.eval("release_weak[0]() is None"), true);
    drain();
    assert.equal(python.stats().objects, before + 1);
    assert.equal(await python.eval("release_second"), value);
    assert.equal(await pool.submit(python.main.release_alias, "release_second"), true);
    assert.equal(await python.eval("release_weak[1]() is None"), true);
    drain();
    assert.equal(python.stats().objects, before);
  } finally {
    await pool.shutdown();
  }
});
