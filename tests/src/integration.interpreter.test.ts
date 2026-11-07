import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { probeInterpreter } from "../../dist/interpreter.js";

for (const { module, example } of [
  { module: "lxml", example: "lxml" },
  { module: "numpy", example: "basics" },
  { module: "cryptography", example: "cryptography" },
]) {
  it(`identifies the selected interpreter when ${module} is missing`, async () => {
    const info = await probeInterpreter();
    const exampleUrl = new URL(`../../examples/${example}.ts`, import.meta.url);
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import { Python } from ${JSON.stringify(new URL("../../dist/index.js", import.meta.url).href)};
const python = await Python.initialize({ stdin: false });
await python.exec(\`
import sys
class MissingPackage:
    def find_spec(self, fullname, path=None, target=None):
        if fullname == "${module}":
            raise ModuleNotFoundError("No module named '${module}'", name="${module}")
sys.meta_path.insert(0, MissingPackage())
\`);
await import(${JSON.stringify(exampleUrl.href)});
`,
      ],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        env: { ...process.env, PYTHON: info.executable },
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.equal(child.stderr, "");
    assert.ok(child.stdout.includes(info.executable), child.stdout);
    assert.ok(child.stdout.includes(info.version), child.stdout);
    assert.ok(child.stdout.includes(`-m pip install ${module}`), child.stdout);
    assert.match(child.stdout, /PYTHON/);
    assert.match(child.stdout, /skipped/);
  });
}

it("terminates a real interpreter whose startup probe stalls", { timeout: 25_000 }, async () => {
  const info = await probeInterpreter();
  const directory = await mkdtemp(path.join(tmpdir(), "node-python-stalled-probe-"));
  const saved = process.env.PYTHONPATH;
  try {
    await writeFile(path.join(directory, "sitecustomize.py"), "import time\ntime.sleep(60)\n");
    process.env.PYTHONPATH = saved ? `${directory}${path.delimiter}${saved}` : directory;
    await assert.rejects(
      () => probeInterpreter(info.executable),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /timed out after 10000ms/);
        const cause: unknown = error.errors[0].cause;
        assert.ok(cause instanceof Error && "killed" in cause && cause.killed === true);
        return true;
      },
    );
  } finally {
    if (saved === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = saved;
    await rm(directory, { recursive: true, force: true });
  }
});
