---
title: Building, testing and internals
---

# Building, testing and internals

## Scripts

```sh
npm run build             # compile TypeScript to dist/
npm run typecheck         # strict typecheck of src/, examples/, scripts/ and tests/
npm run test:types        # public and native declaration type tests
npm run test:unit         # unit tests (no Python runtime required)
npm run test:integration  # integration tests against shared CPython
npm test                  # build + type tests + full unit & integration suite
npm run test:mirror       # full suite under NODE_CTYPES_NO_EXTERNAL_BUFFERS=1 (Electron / mirror mode)
npm run test:backlog      # queued ownership, outcomes and shutdown under backlog
npm run test:stress       # 60-second mixed workload (override with NODE_PYTHON_STRESS_SECONDS)
npm run docs              # generate TypeDoc HTML documentation in docs/
npm run docs:serve        # generate docs and serve locally
npm pack --dry-run        # inspect npm package contents
```

To test against a specific interpreter (such as a free-threaded build or a different Python minor version), set `PYTHON`:

```sh
PYTHON=/path/to/python3.14t npm test
```

`test:backlog` and `test:stress` are opt-in, force GC inside isolated child processes, and report memory/latency diagnostics.

## Internal architecture

Implementation diagrams, thread-state transitions and ownership invariants (in Italian) are documented in [FLOWS.md](../FLOWS.md).

## CI and publishing

- The [CI workflow](../.github/workflows/ci.yml) runs `npm test` on Node.js 24 and 26 across Windows, Linux and macOS with Python **3.12, 3.13, 3.14, 3.14t and 3.15**.
- Pushing a `v<version>` tag matching `package.json` publishes to npm via Trusted Publishing (OIDC) once the entire matrix passes (prerelease versions with `-` publish under the `next` dist-tag).
- The [Docs workflow](../.github/workflows/docs.yml) builds the TypeDoc site (`npm run docs`) and deploys it to GitHub Pages on release tags or manual dispatch.
