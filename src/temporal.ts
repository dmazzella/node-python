// Copyright (c) 2026 Damiano Mazzella. MIT License (see LICENSE).
// Temporal (Node.js 26+): date, time and timedelta ↔ PlainDate, PlainTime and Duration.
interface DateFields {
  year: number;
  month: number;
  day: number;
}
interface TimeFields {
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  microsecond: number;
}
interface DurationFields {
  years: number;
  months: number;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  milliseconds: number;
  microseconds: number;
  nanoseconds: number;
}
interface TemporalNamespace {
  PlainDate: new (year: number, month: number, day: number) => DateFields;
  PlainTime: new (hour: number, minute: number, second: number, millisecond: number, microsecond: number) => TimeFields;
  PlainDateTime: new (...fields: number[]) => DateFields & TimeFields;
  Instant: new (...args: never[]) => { epochNanoseconds: bigint };
  ZonedDateTime: new (...args: never[]) => { epochNanoseconds: bigint; timeZoneId: string; offsetNanoseconds: number };
  Duration: new (...fields: number[]) => DurationFields;
}
export const { Temporal } = globalThis as typeof globalThis & { Temporal?: TemporalNamespace };
const NS_PER_US = 1000n;

/** Fields consumed by PythonConversions.fromTemporal(), or null. */
export function temporalFields(value: unknown): unknown[] | null {
  if (!Temporal) return null;
  if (value instanceof Temporal.PlainDate) return ["date", value.year, value.month, value.day];
  if (value instanceof Temporal.PlainTime) return ["time", value.hour, value.minute, value.second, value.millisecond * 1000 + value.microsecond];
  if (value instanceof Temporal.PlainDateTime) return ["datetime", value.year, value.month, value.day, value.hour, value.minute, value.second, value.millisecond * 1000 + value.microsecond];
  if (value instanceof Temporal.Instant) return ["instant", value.epochNanoseconds / NS_PER_US];
  if (value instanceof Temporal.ZonedDateTime) return ["zoned", value.epochNanoseconds / NS_PER_US, value.timeZoneId, value.offsetNanoseconds / 1000];
  if (value instanceof Temporal.Duration) {
    if (value.years || value.months) throw new TypeError("A Temporal.Duration with years or months has no timedelta equivalent");
    const micros =
      BigInt(value.weeks * 7 + value.days) * 86_400_000_000n +
      BigInt(value.hours) * 3_600_000_000n +
      BigInt(value.minutes) * 60_000_000n +
      BigInt(value.seconds) * 1_000_000n +
      BigInt(value.milliseconds) * 1000n +
      BigInt(value.microseconds) +
      BigInt(value.nanoseconds) / NS_PER_US;
    return ["duration", micros];
  }
  return null;
}
