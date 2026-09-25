import type { Row } from "./client.js";

/**
 * Utilization Board helpers. The board shows each cell as "N jobs · X%",
 * "N jobs · 0%" when shifts exist but nothing is booked, and "N jobs · No
 * shifts" when the business unit has no shift hours that day. The public API
 * sends `percentBooked: null` for that last case.
 */

export const NO_SHIFTS = "No shifts";

export function numeric(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** The board's cell text for one row, e.g. "37 jobs · 99%" or "0 jobs · No shifts". */
export function boardCell(row: Row): string {
  const jobs = numeric(row.jobs);
  const pct = row.percentBooked;
  const shown = pct === null || pct === undefined ? NO_SHIFTS : `${String(pct)}%`;
  return `${jobs} ${jobs === 1 ? "job" : "jobs"} · ${shown}`;
}

/** Rows as the get tool shows them: the board cell added, everything else as the API sent it. */
export function withBoardCell(rows: Row[]): Row[] {
  return rows.map((r) => ({ ...r, board: boardCell(r) }));
}

/**
 * % booked the way Netic computes it (checked against 2,232 live rows on
 * 2026-09-25): job hours over available hours (shift minus non-job), rounded;
 * null with no shift hours; 0 when shifts exist but none of it is available.
 * Netic uses unrounded hours, so a value recomputed from the API's 0.1-hour
 * figures can differ by a point.
 */
export function percentBooked(jobHours: number, shiftHours: number, availableHours: number): number | null {
  if (shiftHours <= 0) return null;
  if (availableHours <= 0) return 0;
  return Math.round((jobHours / availableHours) * 100);
}

/** Case-insensitive match on a business unit or group name, ignoring stray spaces ("HVAC Sales " on Blue Sky). */
export function namePredicate(names: string | string[] | undefined): ((row: Row) => boolean) | undefined {
  if (names === undefined) return undefined;
  const wanted = new Set((Array.isArray(names) ? names : [names]).map((n) => n.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return undefined;
  return (row) => typeof row.name === "string" && wanted.has(row.name.trim().toLowerCase());
}

/** Footer notes from the utilization envelope. */
export function utilizationNotes(extras: Record<string, unknown>): string[] {
  const notes: string[] = [];
  if (typeof extras.timeZone === "string") notes.push(`timeZone ${extras.timeZone}`);
  notes.push(typeof extras.snapshotAt === "string" ? `Point in time: board as it stood at ${extras.snapshotAt}` : "Live board");
  return notes;
}
