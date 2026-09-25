export class DateError extends Error {
  override name = "DateError";
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

function toUtc(value: string): number {
  return Date.parse(`${value}T00:00:00Z`);
}

/** Days covered by an inclusive range: [d, d] is 1. */
export function inclusiveDays(start: string, end: string): number {
  return Math.round((toUtc(end) - toUtc(start)) / 86_400_000) + 1;
}

export function addDays(value: string, days: number): string {
  return new Date(toUtc(value) + days * 86_400_000).toISOString().slice(0, 10);
}

export interface RangeNames {
  start: string;
  end: string;
}

/**
 * Problem with an inclusive start..end range, or undefined when it is fine.
 * Both bounds are inclusive in the tenant's local timezone (spec, "Date
 * filtering"). `names` are the API's parameter names, for the messages.
 */
export function rangeViolation(
  start: string | undefined,
  end: string | undefined,
  names: RangeNames = { start: "createdOnOrAfter", end: "createdBefore" },
): string | undefined {
  if (start === undefined || start === "") return `${names.start} (start) is required, YYYY-MM-DD.`;
  if (end === undefined || end === "") return `${names.end} (end) is required, YYYY-MM-DD. It is inclusive.`;
  if (!isIsoDate(start)) return `Start date "${start}" is not a real date in YYYY-MM-DD form.`;
  if (!isIsoDate(end)) return `End date "${end}" is not a real date in YYYY-MM-DD form.`;
  if (end < start) return `End date ${end} is before start date ${start}. Both bounds are inclusive, so a single day is start = end.`;
  return undefined;
}

/**
 * Split an inclusive range into inclusive chunks of at most `maxDays` days.
 * Each chunk starts the day after the previous one ends.
 */
export function splitRange(start: string, end: string, maxDays: number): Array<{ start: string; end: string }> {
  const chunks: Array<{ start: string; end: string }> = [];
  for (let from = start; from <= end; from = addDays(from, maxDays)) {
    const last = addDays(from, maxDays - 1);
    chunks.push({ start: from, end: last < end ? last : end });
  }
  return chunks;
}

/**
 * The latest calendar date it is anywhere on Earth (UTC+14). A snapshot date
 * after this is in the future for every tenant; closer calls are left to the
 * API, which knows the tenant's timezone.
 */
export function latestDateAnywhere(now: Date = new Date()): string {
  return new Date(now.getTime() + 14 * 3_600_000).toISOString().slice(0, 10);
}
