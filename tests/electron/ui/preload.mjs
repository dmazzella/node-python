// Preload (renderer process, unsandboxed): the page's bridge to the main
// process, and a Python runtime in the renderer itself, whose JavaScript
// thread is the one that renders the page.
import { contextBridge, ipcRenderer } from "electron";

let python;
let noop;

async function rendererBurst(count) {
  if (!python) {
    const { Python } = await import(new URL("../../../dist/index.js", import.meta.url).href);
    // No console in the renderer: Python's output goes to DevTools.
    python = await Python.initialize({ stdin: false, stdout: "console", stderr: "console" });
    await python.exec("def noop(x):\n    return x\n");
    noop = python.main.noop;
    await python.exec("import sys\nprint('Python', sys.version.split()[0], 'in the renderer')");
  }
  const started = performance.now();
  const calls = Array.from({ length: count }, (_, i) => noop(i));
  const submitted = performance.now();
  const results = await Promise.all(calls);
  const settled = performance.now();
  if (results.some((value, i) => value !== i)) throw new Error("wrong result");
  return { submitMs: Math.round(submitted - started), settleMs: Math.round(settled - submitted) };
}

contextBridge.exposeInMainWorld("demo", {
  info: () => ipcRenderer.invoke("info"),
  ping: () => ipcRenderer.invoke("ping"),
  mainBurst: (count) => ipcRenderer.invoke("burst", count),
  rendererBurst,
});
