// Copyright (c) 2026 Damiano Mazzella. MIT License (see LICENSE).
import { PythonError, kwargs } from "./values.ts";
import type { InternalPythonObject as PythonObject } from "./types.ts";

/** Standard-library operations invoked through the runtime's C API proxies. */
export class PythonConversions {
  #builtins: PythonObject;
  #mapping: PythonObject;
  #mutableMapping: PythonObject;
  #numbers: PythonObject;
  #datetime: PythonObject;
  #zoneinfo: PythonObject;
  #operator: PythonObject;
  #traceback: PythonObject;
  #epoch: PythonObject;
  #microsecond: PythonObject;

  constructor(builtins: PythonObject, importModule: (name: string) => PythonObject) {
    this.#builtins = builtins;
    const abc = importModule("collections.abc");
    this.#mapping = abc.Mapping;
    this.#mutableMapping = abc.MutableMapping;
    this.#numbers = importModule("numbers");
    this.#datetime = importModule("datetime");
    this.#zoneinfo = importModule("zoneinfo");
    this.#operator = importModule("operator");
    this.#traceback = importModule("traceback");
    this.#epoch = this.#datetime.datetime(1970, 1, 1, kwargs({ tzinfo: this.#datetime.timezone.utc }));
    this.#microsecond = this.#datetime.timedelta(kwargs({ microseconds: 1 }));
  }

  getFallback(object: PythonObject, name: string): unknown {
    if (this.#builtins.isinstance(object, this.#mapping) && (this.#operator.contains(object, name) || name !== "length")) return this.#operator.getitem(object, name);
    if (name === "length" && this.#builtins.hasattr(this.#builtins.type(object), "__len__")) return this.#builtins.len(object);
    return this.#builtins.getattr(object, name);
  }

  setFallback(object: PythonObject, name: string, value: unknown): void {
    if (this.#builtins.isinstance(object, this.#mutableMapping)) this.#operator.setitem(object, name, value);
    else this.#builtins.setattr(object, name, value);
  }

  deleteFallback(object: PythonObject, name: string): void {
    if (this.#builtins.isinstance(object, this.#mutableMapping)) this.#operator.delitem(object, name);
    else this.#builtins.delattr(object, name);
  }

  isKey(object: PythonObject, name: string): boolean {
    if (this.#builtins.isinstance(object, this.#mapping)) return this.#operator.contains(object, name);
    const attributes = this.#builtins.getattr(object, "__dict__", null);
    if (attributes === null) return false;
    try {
      return this.#operator.contains(attributes, name);
    } finally {
      attributes[Symbol.dispose]();
    }
  }

  item(object: PythonObject, key: unknown): unknown {
    return this.#builtins.isinstance(object, this.#mapping) ? this.#operator.getitem(object, key) : this.#builtins.getattr(object, key);
  }

  keys(object: PythonObject): string[] {
    const mapping = this.#builtins.isinstance(object, this.#mapping);
    const attributes = mapping ? null : this.#builtins.getattr(object, "__dict__", null);
    if (!mapping && attributes === null) return [];
    const iterator = this.#builtins.iter(mapping ? object : attributes);
    try {
      return [...iterator].filter((key): key is string => typeof key === "string");
    } finally {
      iterator[Symbol.dispose]();
      attributes?.[Symbol.dispose]();
    }
  }

  toPrimitive(object: PythonObject, hint: string): unknown {
    if (hint !== "string" && this.#builtins.isinstance(object, this.#datetime.datetime)) return this.timestamp(object);
    if (hint !== "string" && this.#builtins.isinstance(object, this.#numbers.Number)) {
      try {
        return this.#builtins.isinstance(object, this.#numbers.Integral) ? this.#builtins.int(object) : this.#builtins.float(object);
      } catch (error) {
        if (!(error instanceof PythonError) || error.type !== "TypeError") throw error;
        error.exception[Symbol.dispose]();
      }
    }
    return this.#builtins.str(object);
  }

  timestamp(object: PythonObject): number | null {
    if (!this.#builtins.isinstance(object, this.#datetime.datetime)) return null;
    let local: PythonObject | undefined;
    try {
      if (object.tzinfo === null) local = object.astimezone();
      const delta = this.#operator.sub(local ?? object, this.#epoch);
      try {
        return this.#operator.truediv(this.#operator.floordiv(delta, this.#microsecond), 1000);
      } finally {
        delta[Symbol.dispose]();
      }
    } catch (error) {
      if (!(error instanceof PythonError) || !["OverflowError", "ValueError", "OSError"].includes(error.type)) throw error;
      error.exception[Symbol.dispose]();
      return null;
    } finally {
      local?.[Symbol.dispose]();
    }
  }

  fromTimestamp(ms: number): PythonObject {
    const delta = this.#datetime.timedelta(kwargs({ milliseconds: ms }));
    try {
      return this.#operator.add(this.#epoch, delta);
    } finally {
      delta[Symbol.dispose]();
    }
  }

  toJSValue(object: PythonObject, temporal: boolean): [string, ...number[]] | null {
    const b = this.#builtins;
    const dt = this.#datetime;
    if (b.isinstance(object, dt.datetime)) {
      const ms = this.timestamp(object);
      return ms === null ? null : ["Date", ms];
    }
    if (!temporal) return null;
    if (b.isinstance(object, dt.date)) return ["PlainDate", object.year, object.month, object.day];
    if (b.isinstance(object, dt.time) && object.tzinfo === null) return ["PlainTime", object.hour, object.minute, object.second, object.microsecond];
    if (b.isinstance(object, dt.timedelta)) {
      let total = BigInt(this.#operator.floordiv(object, this.#microsecond));
      const sign = total < 0n ? -1n : 1n;
      if (total < 0n) total = -total;
      const parts: number[] = [];
      for (const unit of [86_400_000_000n, 3_600_000_000n, 60_000_000n, 1_000_000n, 1000n]) {
        parts.push(Number(sign * (total / unit)));
        total %= unit;
      }
      return ["Duration", ...parts, Number(sign * total)];
    }
    return null;
  }

  fromTemporal(fields: unknown[]): PythonObject {
    const [kind, ...values] = fields;
    const dt = this.#datetime;
    switch (kind) {
      case "date":
        return dt.date(...values);
      case "time":
        return dt.time(...values);
      case "datetime":
        return dt.datetime(...values);
      case "instant":
      case "duration": {
        const delta = this.#operator.mul(values[0], this.#microsecond);
        if (kind === "duration") return delta;
        try {
          return this.#operator.add(this.#epoch, delta);
        } finally {
          delta[Symbol.dispose]();
        }
      }
      case "zoned": {
        let timezone: PythonObject;
        try {
          timezone = this.#zoneinfo.ZoneInfo(values[1]);
        } catch (error) {
          if (!(error instanceof PythonError) || !["ZoneInfoNotFoundError", "ValueError"].includes(error.type)) throw error;
          error.exception[Symbol.dispose]();
          const offset = this.#operator.mul(values[2], this.#microsecond);
          try {
            timezone = dt.timezone(offset);
          } finally {
            offset[Symbol.dispose]();
          }
        }
        const instant = this.fromTemporal(["instant", values[0]]);
        try {
          return instant.astimezone(timezone);
        } finally {
          instant[Symbol.dispose]();
          timezone[Symbol.dispose]();
        }
      }
      default:
        throw new TypeError("Unknown Temporal conversion kind");
    }
  }

  formatException(exception: PythonObject): string {
    const type: PythonObject = this.#builtins.type(exception);
    const traceback: PythonObject | null = exception.__traceback__;
    try {
      const lines: PythonObject = this.#traceback.format_exception(type, exception, traceback);
      try {
        return [...lines].join("");
      } finally {
        lines[Symbol.dispose]();
      }
    } finally {
      traceback?.[Symbol.dispose]();
      type[Symbol.dispose]();
    }
  }
}
