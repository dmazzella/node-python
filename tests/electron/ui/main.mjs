// Interactive check: does a burst of Python calls slow down Electron's UI?
// Run after `npm run build`:
//
//   electron tests/electron/ui/main.mjs [--x=<window x>] [--auto]
//
// --auto runs one burst in the main process and one in the renderer, prints
// the table as JSON and quits.
//
// (unset ELECTRON_RUN_AS_NODE if set). The window animates with
// requestAnimationFrame, pings the main process continuously and charts both;
// its buttons run a burst of concurrent Python calls in the main process or in
// the renderer (Python loaded by the preload script).
import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { Python } from "../../../dist/index.js";

const x = Number(process.argv.find((arg) => arg.startsWith("--x="))?.slice(4) ?? NaN);
const nodeCtypes = fileURLToPath(import.meta.resolve("node-ctypes"));
const label = nodeCtypes.includes("node_modules") ? "node-ctypes from node_modules" : "node-ctypes local build";

let python;
let noop;

async function burst(count) {
  const started = performance.now();
  const calls = Array.from({ length: count }, (_, i) => noop(i));
  const submitted = performance.now();
  const results = await Promise.all(calls);
  const settled = performance.now();
  if (results.some((value, i) => value !== i)) throw new Error("wrong result");
  return { submitMs: Math.round(submitted - started), settleMs: Math.round(settled - submitted) };
}

ipcMain.handle("ping", () => true);
ipcMain.handle("burst", (_event, count) => burst(count));
ipcMain.handle("info", async () => ({
  label,
  nodeCtypes,
  version: String((await import("node-ctypes")).Version),
  electron: process.versions.electron,
  python: python.version,
}));

app.whenReady().then(async () => {
  python = await Python.initialize({ stdin: false });
  await python.exec("def noop(x):\n    return x\n");
  noop = python.main.noop;
  const window = new BrowserWindow({
    width: 760,
    height: 720,
    ...(Number.isFinite(x) ? { x, y: 40 } : {}),
    title: label,
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.mjs", import.meta.url)),
      sandbox: false,
      contextIsolation: true,
    },
  });
  await window.loadFile(fileURLToPath(new URL("./index.html", import.meta.url)));
  if (process.argv.includes("--auto")) {
    const report = await window.webContents.executeJavaScript(`(async () => {
      const status = document.getElementById("status");
      const rows = () => document.querySelectorAll("#rows tr").length;
      const settled = async (count) => {
        while (rows() < count && !/error/i.test(status.textContent)) await new Promise((resolve) => setTimeout(resolve, 100));
      };
      await new Promise((resolve) => setTimeout(resolve, 1000));
      document.getElementById("main").click();
      await settled(1);
      document.getElementById("renderer").click();
      await settled(2);
      return {
        status: status.textContent,
        rows: [...document.querySelectorAll("#rows tr")].map((row) => [...row.cells].map((cell) => cell.textContent).join(" | ")),
      };
    })()`);
    console.log(JSON.stringify({ label, ...report }));
    window.close();
  }
});

app.on("window-all-closed", async () => {
  await python?.finalize();
  app.quit();
});
