---
title: Callbacks, modules and JsProxy
---

# Callbacks, modules and JsProxy

## JavaScript functions and classes in Python

Any JavaScript function passed to Python becomes a Python callable; passing it back to JavaScript returns the exact original JavaScript function.

- **Positional and keyword arguments**: positional arguments arrive directly; if Python passes keyword arguments, a final plain object `{ ...kwargs }` is appended to the JavaScript argument list.
- **Classes / constructors**: JavaScript `class` constructors can be invoked directly (`MyClass(1, 2)`) or explicitly with `.new(...)` (`fn.new(1, 2)` for plain constructor functions).
- **Async functions**: an `async` JavaScript function (returning a `Promise`) must be awaited from a Python coroutine (or `.result()` on a background Python thread); calling a Promise-returning JS function synchronously from Python raises a `TypeError`.

```typescript
class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  norm() {
    return Math.hypot(this.x, this.y);
  }
}

python.main.Point = Point;
const n = await python.eval<number>("Point(3, 4).norm()"); // 5
```

## Exposing JavaScript modules

`python.module(name, members)` registers a synthetic Python module in `sys.modules` so Python code can `import` it directly. Dotted names automatically create missing parent packages (`__path__ = []`) and attach submodules:

```typescript
python.module("node.math", {
  hypot: (a: number, b: number) => Math.hypot(a, b),
});

await python.exec(`
from node.math import hypot
result = hypot(3, 4)
`);
console.log(await python.eval("result")); // 5
```

See [examples/module.ts](../examples/module.ts) for mixing JavaScript modules with local Python files.

## Shared JavaScript objects (`JsProxy`)

Class instances (objects with a custom prototype) are automatically shared with Python by reference as native `JsProxy` heap-type objects; wrap plain objects, arrays, `Map`s, `Set`s or `Buffer`s in `byReference(value)` to share them too.

`JsProxy` implements CPython's native type slots directly:

- **Attributes**: `obj.prop`, `obj.prop = v`, `del obj.prop`, `dir(obj)` (methods bind `this` to `obj`; nested objects reached through a `JsProxy` remain shared by reference)
- **Items & containers**: `obj[key]`, `obj[key] = v`, `del obj[key]`, `len(obj)`, `bool(obj)`, `x in obj` (supports `Array`, typed arrays, `Map`, `Set`, `WeakSet` and plain objects)
- **Iteration**: `for x in obj` (`Symbol.iterator`, `Map.keys()`, or own keys of plain objects) and `async for x in obj` (`Symbol.asyncIterator` or `Symbol.iterator`)
- **Promises**: `await jsPromise` inside Python `asyncio` coroutines
- **Identity & formatting**: `==`, `!=`, `hash(obj)`, `repr(obj)`, `str(obj)`

Python releases `JsProxy` entries via `weakref.finalize`, and `@node-ctypes/python` drains those release queues automatically so JavaScript objects can be garbage collected once Python drops them.

## Cross-thread callbacks and synchronous waits

When a **Python worker thread** (or the asyncio background thread) calls a JavaScript function:

- The call is marshaled onto the hosting Node.js event loop and resolves a `concurrent.futures.Future` (wrapped for `asyncio` when called inside a running event loop).
- If the hosting Node.js thread is currently blocked inside a synchronous Python wait (e.g. `Thread.join()`), a background thread waiting on a JavaScript function warns after 5 seconds about a potential deadlock.
- Passing `synchronousCallbacks: true` to `Python.initialize()` enables serving native `JsProxy` callbacks during interruptible synchronous Python waits using `SIGURG` (POSIX) or `_PyOS_SigintEvent` (Windows Python 3.14+).

See [examples/callbacks.ts](../examples/callbacks.ts) and [examples/threads.ts](../examples/threads.ts).
