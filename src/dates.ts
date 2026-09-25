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

/**
 * Problem with an inclusive `createdOnOrAfter`..`createdBefore` range, or
 * undefined when it is fine. Both bounds are inclusive in the tenant's local
 * timezone (spec, "Date filtering").
 */
export function rangeViolation(start: string | undefined, end: string | undefined): string | undefined {
  if (start === undefined || start === "") return "createdOnOrAfter (start) is required, YYYY-MM-DD.";
  if (end === undefined || end === "") return "createdBefore (end) is required, YYYY-MM-DD. It is inclusive.";
  if (!isIsoDate(start)) return `Start date "${start}" is not a real date in YYYY-MM-DD form.`;
  if (!isIsoDate(end)) return `End date "${end}" is not a real date in YYYY-MM-DD form.`;
  if (end < start) return `End date ${end} is before start date ${start}. Both bounds are inclusive, so a single day is start = end.`;
  return undefined;
}
