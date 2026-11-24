---
title: Examples
---

# Examples

Runnable TypeScript examples built on `@node-ctypes/python`. Build the package once (`npm run build`), then execute any example directly with Node.js 24+:

```sh
npm run build
node examples/basics.ts
```

| Example                            | Focus                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| [basics.ts](basics.ts)             | Values, live proxies, errors, conversions and context managers                             |
| [callbacks.ts](callbacks.ts)       | JavaScript callbacks, constructors (`.new()`) and `JsProxy`                                |
| [threads.ts](threads.ts)           | Python threads and cross-thread JavaScript callbacks                                       |
| [async.ts](async.ts)               | `asyncio` coroutines, `python.run()` cancellation and async iterators                      |
| [module.ts](module.ts)             | Registering JavaScript modules (`python.module`) and local Python imports (`inventory.py`) |
| [worker.ts](worker.ts)             | Hosting CPython inside a dedicated Node.js `worker_threads` worker                         |
| [cryptography.ts](cryptography.ts) | Using Python's `cryptography` package from Node.js                                         |
| [lxml.ts](lxml.ts)                 | XML parsing, XPath, XSLT and canonicalization with `lxml`                                  |

Optional third-party Python packages (`cryptography`, `lxml`, listed in `tests/requirements-examples.txt`) are needed only for their respective examples and must be installed into the selected Python interpreter (`PYTHON=/path/to/python`).

For conceptual walkthroughs and full API guides, see [Guides](../guides/README.md).
