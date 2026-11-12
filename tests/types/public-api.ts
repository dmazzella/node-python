import { Python, PythonError, Tuple, byReference, cancellable, kwargs } from "@node-ctypes/python";
import type { PythonTypedArray } from "@node-ctypes/python";

const python = await Python.initialize({
  executable: "python3",
  stdin: false,
  stdout: (text: string) => {
    text.toUpperCase();
  },
  stderr: "node",
});

const answer: number = await python.eval<number>("6 * 7");
await Python.initialize({ stdout: "console", stderr: "console" });
// @ts-expect-error stdout accepts "inherit", "node", "console" or a function
await Python.initialize({ stdout: "devtools" });
await Python.initialize({ synchronousCallbacks: true });
await Python.initialize({ synchronousCallbacks: false });
await Python.initialize({ switchInterval: 0.5 });
// @ts-expect-error the switch interval is a number of milliseconds
await Python.initialize({ switchInterval: "0.5" });
// @ts-expect-error native object selection has been removed
await Python.initialize({ nativeObjects: true });
// @ts-expect-error native objects cannot be disabled
await Python.initialize({ nativeObjects: false });
// @ts-expect-error synchronousCallbacks is now a top-level option
await Python.initialize({ nativeObjects: { synchronousCallbacks: true } });
// @ts-expect-error synchronousCallbacks must be boolean
await Python.initialize({ synchronousCallbacks: "yes" });
const tuple: Tuple<number> = Tuple.of(1, 2);
const values: number[] = tuple.map((value) => value * 2);
const marker = byReference({ answer });
await python.main.use(marker, kwargs({ enabled: true }));
python.module("typed", {
  operation: cancellable(async (value: number, signal: AbortSignal) => {
    signal.throwIfAborted();
    return value * 2;
  }),
});

const result = python.with((await python.import("threading")).Lock(), () => 42);
const numericResult: Promise<number | undefined> = result;
const asyncResult: Promise<number | undefined> = python.asyncWith(await python.main.manager(), async () => 42);
const running = python.run(python.main.task(), { signal: new AbortController().signal });
const aborted: Promise<number> = python.run<number>(python.eval<number>("6 * 7"), { signal: AbortSignal.timeout(100) });
void [values, numericResult, asyncResult, running, aborted];

try {
  await python.eval("1 / 0");
} catch (error) {
  if (error instanceof PythonError) {
    const type: string = error.type;
    const traceback: string = error.traceback;
    void [type, traceback, error.exception];
  }
}

// @ts-expect-error executable paths must be strings
await Python.initialize({ executable: 123 });
// @ts-expect-error stream options cannot be booleans
await Python.initialize({ stdout: false });
// @ts-expect-error code must be a string
await python.exec(123);
// @ts-expect-error eval requires a string expression
await python.eval(123);
// @ts-expect-error an AbortSignal is required
python.run(python.main.task(), { signal: "cancel" });
// @ts-expect-error kwargs requires named values
kwargs(123);

const half: PythonTypedArray = new Float16Array(2);
void half;
