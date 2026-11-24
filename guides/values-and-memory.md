---
title: Values, memory and lifetime
---

# Values, memory and lifetime

## Conversions between JavaScript and Python

| JavaScript                                    | Python                                      | Back to JavaScript (shallow / deep)                                       |
| --------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| `null` / `undefined`                          | `None`                                      | `null`                                                                    |
| `boolean`                                     | `bool`                                      | `boolean`                                                                 |
| `number` (safe int / float)                   | `int` / `float`                             | `number` (Python `int` outside safe JS integer range becomes `bigint`)    |
| `bigint`                                      | `int` (`int64` fast path, arbitrary width)  | `number` if safe integer, else `bigint`                                   |
| `string`                                      | `str` (UTF-8, embedded NULs preserved)      | `string`                                                                  |
| `Buffer` / `Uint8Array`                       | `bytes` (copied)                            | `Buffer`                                                                  |
| Other typed arrays, `ArrayBuffer`, `DataView` | Shared `memoryview` (zero-copy)             | Live proxy (use `.toTypedArray()`)                                        |
| `Array` / `Tuple` (`Tuple.of(1, 2)`)          | `list` / `tuple` (copied)                   | Live proxy (shallow) / `Array` / `Tuple` (deep)                           |
| Plain object / `Map`                          | `dict` (copied)                             | Live proxy (shallow) / plain object if all string keys, else `Map` (deep) |
| `Set`                                         | `set` (copied)                              | Live proxy (shallow) / `Set` (deep)                                       |
| `Date`                                        | UTC `datetime.datetime`                     | Live proxy (shallow) / `Date` (deep)                                      |
| `Temporal` (Node.js 26+)                      | `date`, `time`, `datetime`, `timedelta`     | Live proxy (shallow) / `PlainDate`, `PlainTime`, `Duration` (deep)        |
| `byReference(value)`                          | Shared `JsProxy` or writable `memoryview`   | Original JavaScript object / buffer                                       |
| Class instances (custom prototype)            | Shared `JsProxy`                            | Original JavaScript object                                                |
| Functions / classes                           | Python callable (`.new()` for constructors) | Original JavaScript function / class                                      |

### Shallow vs deep conversion

- **Ordinary calls** (`await fn()`, attribute reads, indexing) perform **shallow** conversion: scalars, strings and `bytes` convert directly; Python containers (`list`, `tuple`, `dict`, `set`), dates and custom objects stay **live proxies**.
- **`await python.eval(expr)`**, **`proxy.toJS()`** and **`JSON.stringify(proxy)`** (`toJSON()`) perform **deep** conversion of nested containers, `datetime`, and `Temporal` values.
- Circular containers cannot be deep-copied in either direction (throws `TypeError`); use live proxies or `byReference()` instead.
- `python.toPython(value)` explicitly converts a JavaScript value into a live, disposable Python proxy (useful to avoid converting the same large container across repeated calls).

### Keyword arguments (`kwargs`)

Pass keyword arguments as the final argument of any Python call using `kwargs({...})`:

```typescript
import { kwargs } from "@node-ctypes/python";

const json = await python.import("json");
const text = await json.dumps({ b: 2, a: 1 }, kwargs({ indent: 2, sort_keys: true }));
```

### Live proxy behavior

On a live Python proxy:

- Python attributes take precedence over mapping keys (e.g. `dict.keys` is the method; use `dict["keys"]` or check `in` / `Object.keys(dict)` for keys).
- Integer string properties (`items[0]`, `items[-1]`) use Python item access (`__getitem__` / `__setitem__`).
- `for (const x of proxy)` iterates synchronously through `PyObject_GetIter` / `PyIter_Next`; `Object.keys(proxy)` and `{ ...proxy }` enumerate string keys of mappings.

## Shared buffers and typed arrays

- **`Buffer` / `Uint8Array`** copy to immutable Python `bytes` by default. Wrap them in `byReference(buf)` to expose a **writable zero-copy `memoryview`** sharing the underlying backing store.
- **Other typed arrays (`Float64Array`, `Int32Array`, ...), `ArrayBuffer` and `DataView`** are exposed as shared `memoryview`s automatically.
- **`proxy.toTypedArray()`** exports any C-contiguous Python buffer (`bytearray`, `array.array`, `memoryview`, `numpy.ndarray`, ...) as a matching JavaScript typed array:
  - Read-only buffers (such as `bytes`) are copied.
  - Writable buffers share memory directly on standard Node.js (`EXTERNAL_BUFFERS === true`), keeping the Python buffer pinned while the typed array's `ArrayBuffer` is alive.
  - When external buffers are disabled (Electron / `NODE_CTYPES_NO_EXTERNAL_BUFFERS=1`), `toTypedArray()` copies the bytes and releases the Python buffer export lock immediately so Python can continue resizing the buffer (e.g. `bytearray.append()`).
- Never detach, transfer or resize backing memory while it is shared across the boundary.

## Lifetime and deterministic disposal

Every live Python proxy owns a `PyObject` reference. While a `FinalizationRegistry` releases forgotten proxies in batched `#drain()` passes as a safety net, GC is nondeterministic — dispose proxies explicitly with `using` or `[Symbol.dispose]()` when practical (including `error.exception` on caught `PythonError`s):

```typescript
using items = python.toPython([3, 1, 2]);
await items.sort();
console.log(items.toJS()); // [1, 2, 3]
// items is released deterministically at scope exit
```

On free-threaded CPython builds (`Py_GIL_DISABLED=1`), disposal drops the reference immediately, while CPython's biased reference counting may defer running `__del__` until the thread that originally created the object next executes Python code.
