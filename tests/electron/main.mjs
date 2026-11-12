// Manual check in Electron's main process, whose JavaScript thread also runs
// the UI (window and IPC events). Run after `npm run build`:
//
//   electron tests/electron/main.mjs
//
// (unset ELECTRON_RUN_AS_NODE if set). Prints a JSON report and exits with 0
// when every check passed. The burst checks also report how long the event loop
// was held (`turns`, `longestStall`), to compare node-ctypes versions.
import { app } from "electron";
import { Python } from "../../dist/index.js";

const checks = {};
const check = async (name, body) => {
  try {
    checks[name] = { ok: true, value: await body() };
  } catch (error) {
    checks[name] = { ok: false, error: String(error?.stack ?? error) };
  }
};

// A burst of `count` concurrent calls: results in order, event loop turns while
// it settles, and the longest gap between two 1 ms timer ticks.
async function burst(call, count) {
  let turns = 0;
  let running = true;
  const turn = () => {
    if (!running) return;
    turns++;
    setImmediate(turn);
  };
  let last = performance.now();
  let longestStall = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longestStall = Math.max(longestStall, now - last);
    last = now;
  }, 1);
  const started = performance.now();
  const calls = Array.from({ length: count }, (_, i) => call(i));
  const submitted = performance.now();
  setImmediate(turn);
  const results = await Promise.all(calls);
  running = false;
  const settled = performance.now();
  longestStall = Math.max(longestStall, settled - last);
  clearInterval(timer);
  results.forEach((value, i) => {
    if (value !== i) throw new Error(`call ${i} returned ${value}`);
  });
  return {
    count,
    submitMs: Math.round(submitted - started),
    settleMs: Math.round(settled - submitted),
    turns,
    longestStallMs: Math.round(longestStall),
  };
}

app.whenReady().then(async () => {
  let python;
  await check("initialize", async () => {
    python = await Python.initialize({ stdin: false });
    return { version: python.version };
  });
  if (python) {
    await python.exec(`
import time
def noop(x):
    return x
def sleep(seconds):
    time.sleep(seconds)
    return seconds
`);
    const { noop, sleep } = python.main;

    await check("calls and results", async () => {
      const math = await python.import("math");
      const values = { sqrt: await math.sqrt(16), eval: await python.eval("6 * 7"), noop: await noop("electron") };
      if (values.sqrt !== 4 || values.eval !== 42 || values.noop !== "electron") throw new Error(JSON.stringify(values));
      return values;
    });

    await check("UI thread free during a 500 ms Python call", async () => {
      let ticks = 0;
      const timer = setInterval(() => ticks++, 10);
      await sleep(0.5);
      clearInterval(timer);
      if (ticks < 15) throw new Error(`the event loop was blocked (${ticks} ticks)`);
      return { ticks };
    });

    await check("sequential calls", async () => {
      for (let i = 0; i < 500; i++) await noop(i);
      const started = performance.now();
      for (let i = 0; i < 5000; i++) if ((await noop(i)) !== i) throw new Error(`call ${i}`);
      return { microsecondsPerCall: Math.round(((performance.now() - started) * 1000) / 5000) };
    });

    await check("burst of 1000 calls", () => burst(noop, 1000));
    await check("burst of 5000 calls", () => burst(noop, 5000));

    await check("finalize", async () => {
      await python.finalize();
      return true;
    });
  }

  const ok = Object.values(checks).every((entry) => entry.ok);
  const nodeCtypes = (await import("node-ctypes")).Version;
  console.log(
    JSON.stringify(
      {
        electron: process.versions.electron,
        node: process.versions.node,
        arch: process.arch,
        nodeCtypes: { version: String(nodeCtypes), from: import.meta.resolve("node-ctypes") },
        ok,
        checks,
      },
      null,
      2,
    ),
  );
  app.exit(ok ? 0 : 1);
});
