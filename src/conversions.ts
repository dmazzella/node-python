// Copyright (c) 2026 Damiano Mazzella. MIT License (see LICENSE).
import { PythonError, kwargs } from "./values.ts";
import type { InternalPythonObject as PythonObject } from "./types.ts";

/** Standard-library operations invoked through the runtime's C API proxies. */
export class PythonConversions {
  #isinstance: PythonObject;
  #hasattr: PythonObject;
  #getattr: PythonObject;
  #setattr: PythonObject;
  #delattr: PythonObject;
  #len: PythonObject;
  #iter: PythonObject;
  #str: PythonObject;
  #int: PythonObject;
  #float: PythonObject;
  #typeFn: PythonObject;
  #mapping: PythonObject;
  #mutableMapping: PythonObject;
  #numberType: PythonObject;
  #integralType: PythonObject;
  #dtDatetime: PythonObject;
  #dtDate: PythonObject;
  #dtTime: PythonObject;
  #dtTimedelta: PythonObject;
  #dtTimezone: PythonObject;
  #zoneInfo: PythonObject;
  #contains: PythonObject;
  #getitem: PythonObject;
  #setitem: PythonObject;
  #delitem: PythonObject;
  #add: PythonObject;
  #sub: PythonObject;
  #mul: PythonObject;
  #floordiv: PythonObject;
  #truediv: PythonObject;
  #formatException: PythonObject;
  #epoch: PythonObject;
  #microsecond: PythonObject;

  constructor(builtins: PythonObject, importModule: (name: string) => PythonObject) {
    this.#isinstance = builtins.isinstance;
    this.#hasattr = builtins.hasattr;
    this.#getattr = builtins.getattr;
    this.#setattr = builtins.setattr;
    this.#delattr = builtins.delattr;
    this.#len = builtins.len;
    this.#iter = builtins.iter;
    this.#str = builtins.str;
    this.#int = builtins.int;
    this.#float = builtins.float;
    this.#typeFn = builtins.type;
    using abc = importModule("collections.abc");
    this.#mapping = abc.Mapping;
    this.#mutableMapping = abc.MutableMapping;
    using numbers = importModule("numbers");
    this.#numberType = numbers.Number;
    this.#integralType = numbers.Integral;
    using datetime = importModule("datetime");
    this.#dtDatetime = datetime.datetime;
    this.#dtDate = datetime.date;
    this.#dtTime = datetime.time;
    this.#dtTimedelta = datetime.timedelta;
    this.#dtTimezone = datetime.timezone;
    using zoneinfo = importModule("zoneinfo");
    this.#zoneInfo = zoneinfo.ZoneInfo;
    using operator = importModule("operator");
    this.#contains = operator.contains;
    this.#getitem = operator.getitem;
    this.#setitem = operator.setitem;
    this.#delitem = operator.delitem;
    this.#add = operator.add;
    this.#sub = operator.sub;
    this.#mul = operator.mul;
    this.#floordiv = operator.floordiv;
    this.#truediv = operator.truediv;
    using traceback = importModule("traceback");
    this.#formatException = traceback.format_exception;
    using utc = this.#dtTimezone.utc;
    this.#epoch = this.#dtDatetime(1970, 1, 1, kwargs({ tzinfo: utc }));
    this.#microsecond = this.#dtTimedelta(kwargs({ microseconds: 1 }));
  }

  getFallback(object: PythonObject, name: string): unknown {
    if (this.#isinstance(object, this.#mapping) && (this.#contains(object, name) || name !== "length")) return this.#getitem(object, name);
    if (name === "length") {
      using type = this.#typeFn(object);
      if (this.#hasattr(type, "__len__")) return this.#len(object);
    }
    return this.#getattr(object, name);
  }

  setFallback(object: PythonObject, name: string, value: unknown): void {
    if (this.#isinstance(object, this.#mutableMapping)) this.#setitem(object, name, value);
    else this.#setattr(object, name, value);
  }

  deleteFallback(object: PythonObject, name: string): void {
    if (this.#isinstance(object, this.#mutableMapping)) this.#delitem(object, name);
    else this.#delattr(object, name);
  }

  isKey(object: PythonObject, name: string): boolean {
    if (this.#isinstance(object, this.#mapping)) return this.#contains(object, name);
    const attributes = this.#getattr(object, "__dict__", null);
    if (attributes === null) return false;
    try {
      return this.#contains(attributes, name);
    } finally {
      attributes[Symbol.dispose]();
    }
  }

  item(object: PythonObject, key: unknown): unknown {
    return this.#isinstance(object, this.#mapping) ? this.#getitem(object, key) : this.#getattr(object, key);
  }

  keys(object: PythonObject): string[] {
    const mapping = this.#isinstance(object, this.#mapping);
    const attributes = mapping ? null : this.#getattr(object, "__dict__", null);
    if (!mapping && attributes === null) return [];
    const iterator = this.#iter(mapping ? object : attributes);
    try {
      return [...iterator].filter((key): key is string => typeof key === "string");
    } finally {
      iterator[Symbol.dispose]();
      attributes?.[Symbol.dispose]();
    }
  }

  toPrimitive(object: PythonObject, hint: string): unknown {
    if (hint !== "string" && this.#isinstance(object, this.#dtDatetime)) return this.timestamp(object);
    if (hint !== "string" && this.#isinstance(object, this.#numberType)) {
      try {
        return this.#isinstance(object, this.#integralType) ? this.#int(object) : this.#float(object);
      } catch (error) {
        if (!(error instanceof PythonError) || error.type !== "TypeError") throw error;
        error.exception[Symbol.dispose]();
      }
    }
    return this.#str(object);
  }

  timestamp(object: PythonObject): number | null {
    if (!this.#isinstance(object, this.#dtDatetime)) return null;
    let local: PythonObject | undefined;
    try {
      using tzinfo = object.tzinfo;
      if (tzinfo === null) {
        using astimezone = object.astimezone;
        local = astimezone();
      }
      const delta = this.#sub(local ?? object, this.#epoch);
      try {
        return this.#truediv(this.#floordiv(delta, this.#microsecond), 1000);
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
    const delta = this.#dtTimedelta(kwargs({ milliseconds: ms }));
    try {
      return this.#add(this.#epoch, delta);
    } finally {
      delta[Symbol.dispose]();
    }
  }

  toJSValue(object: PythonObject, temporal: boolean): [string, ...number[]] | null {
    if (this.#isinstance(object, this.#dtDatetime)) {
      const ms = this.timestamp(object);
      return ms === null ? null : ["Date", ms];
    }
    if (!temporal) return null;
    if (this.#isinstance(object, this.#dtDate)) return ["PlainDate", object.year, object.month, object.day];
    if (this.#isinstance(object, this.#dtTime)) {
      using tzinfo = object.tzinfo;
      if (tzinfo === null) return ["PlainTime", object.hour, object.minute, object.second, object.microsecond];
    }
    if (this.#isinstance(object, this.#dtTimedelta)) {
      let total = BigInt(this.#floordiv(object, this.#microsecond));
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
    switch (kind) {
      case "date":
        return this.#dtDate(...values);
      case "time":
        return this.#dtTime(...values);
      case "datetime":
        return this.#dtDatetime(...values);
      case "instant":
      case "duration": {
        const delta = this.#mul(values[0], this.#microsecond);
        if (kind === "duration") return delta;
        try {
          return this.#add(this.#epoch, delta);
        } finally {
          delta[Symbol.dispose]();
        }
      }
      case "zoned": {
        let timezone: PythonObject;
        try {
          timezone = this.#zoneInfo(values[1]);
        } catch (error) {
          if (!(error instanceof PythonError) || !["ZoneInfoNotFoundError", "ValueError"].includes(error.type)) throw error;
          error.exception[Symbol.dispose]();
          const offset = this.#mul(values[2], this.#microsecond);
          try {
            timezone = this.#dtTimezone(offset);
          } finally {
            offset[Symbol.dispose]();
          }
        }
        const instant = this.fromTemporal(["instant", values[0]]);
        try {
          using astimezone = instant.astimezone;
          return astimezone(timezone);
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
    const type: PythonObject = this.#typeFn(exception);
    const traceback: PythonObject | null = exception.__traceback__;
    try {
      const lines: PythonObject = this.#formatException(type, exception, traceback);
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
