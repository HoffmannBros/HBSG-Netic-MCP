import type { Row } from "./client.js";
import { UTILIZATION_SUM_FIELDS } from "./endpoints.js";
import { cellKey } from "./rows.js";
import { numeric, percentBooked } from "./utilization.js";

export interface Group {
  values: string[];
  count: number;
}

/** Counts rows grouped by up to three fields. Blank cells group as "(blank)". */
export class GroupCounter {
  private readonly counts = new Map<string, Group>();
  total = 0;

  constructor(readonly fields: string[]) {}

  add(row: Row): void {
    this.total += 1;
    const values = this.fields.map((f) => cellKey(row[f]));
    const key = JSON.stringify(values);
    const group = this.counts.get(key);
    if (group) group.count += 1;
    else this.counts.set(key, { values, count: 1 });
  }

  addMany(rows: Iterable<Row>): void {
    for (const row of rows) this.add(row);
  }

  /** Largest group first; ties in field-value order. */
  groups(): Group[] {
    return [...this.counts.values()].sort((a, b) => b.count - a.count || a.values.join("\u0000").localeCompare(b.values.join("\u0000")));
  }
}

/** A number from a cell: numbers, and strings that parse as one. Blanks, booleans, and text are not numbers. */
export function numericCell(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : undefined;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface AvgGroup {
  values: string[];
  /** Rows in the group. */
  rows: number;
  /** Rows with a numeric value, which the average covers. */
  n: number;
  /** Rounded to 3 decimals; null when no row had a number. */
  avg: number | null;
  min: number | null;
  max: number | null;
}

/** Averages one numeric column per group. Rows without a number count in rows and skipped, not in n. */
export class GroupAverager {
  private readonly groupsByKey = new Map<string, { values: string[]; rows: number; n: number; sum: number; min: number; max: number }>();
  total = 0;
  skipped = 0;
  private n = 0;
  private sum = 0;

  constructor(
    readonly fields: string[],
    readonly value: string,
  ) {}

  add(row: Row): void {
    this.total += 1;
    const values = this.fields.map((f) => cellKey(row[f]));
    const key = JSON.stringify(values);
    let g = this.groupsByKey.get(key);
    if (!g) {
      g = { values, rows: 0, n: 0, sum: 0, min: Infinity, max: -Infinity };
      this.groupsByKey.set(key, g);
    }
    g.rows += 1;
    const v = numericCell(row[this.value]);
    if (v === undefined) {
      this.skipped += 1;
      return;
    }
    g.n += 1;
    g.sum += v;
    g.min = Math.min(g.min, v);
    g.max = Math.max(g.max, v);
    this.n += 1;
    this.sum += v;
  }

  addMany(rows: Iterable<Row>): void {
    for (const row of rows) this.add(row);
  }

  /** Over every row, not an average of group averages. */
  overall(): { n: number; avg: number | null } {
    return { n: this.n, avg: this.n > 0 ? round3(this.sum / this.n) : null };
  }

  /** Most rows first, like count; ties in field-value order. */
  groups(): AvgGroup[] {
    return [...this.groupsByKey.values()]
      .map((g) => ({
        values: g.values,
        rows: g.rows,
        n: g.n,
        avg: g.n > 0 ? round3(g.sum / g.n) : null,
        min: g.n > 0 ? round3(g.min) : null,
        max: g.n > 0 ? round3(g.max) : null,
      }))
      .sort((a, b) => b.rows - a.rows || a.values.join("\u0000").localeCompare(b.values.join("\u0000")));
  }
}

export type SumField =(typeof UTILIZATION_SUM_FIELDS)[number];

export interface SumGroup {
  values: string[];
  /** Rows summed, e.g. business-unit days. */
  rows: number;
  sums: Record<SumField, number>;
  /** Recomputed from the sums, never averaged. */
  percentBooked: number | null;
}

/**
 * Sums utilization jobs and hours per group, then recomputes % booked from
 * the sums. A group of one row keeps the API's own percentBooked, which is
 * computed from unrounded hours.
 */
export class GroupSummer {
  private readonly groupsByKey = new Map<string, { values: string[]; rows: number; sums: Record<SumField, number>; only?: Row }>();
  total = 0;
  /** Row types seen (group, business_unit), to warn about double counting. */
  readonly types = new Set<string>();

  constructor(readonly fields: string[]) {}

  add(row: Row): void {
    this.total += 1;
    if (typeof row.type === "string") this.types.add(row.type);
    const values = this.fields.map((f) => cellKey(row[f]));
    const key = JSON.stringify(values);
    let g = this.groupsByKey.get(key);
    if (!g) {
      g = { values, rows: 0, sums: { jobs: 0, jobHours: 0, shiftHours: 0, nonJobHours: 0, availableHours: 0 }, only: row };
      this.groupsByKey.set(key, g);
    } else {
      delete g.only;
    }
    g.rows += 1;
    for (const f of UTILIZATION_SUM_FIELDS) g.sums[f] += numeric(row[f]);
  }

  addMany(rows: Iterable<Row>): void {
    for (const row of rows) this.add(row);
  }

  /** Most job hours first; ties in field-value order. Hours rounded to 0.1. */
  groups(): SumGroup[] {
    return [...this.groupsByKey.values()]
      .map((g) => {
        const sums = { ...g.sums };
        for (const f of UTILIZATION_SUM_FIELDS) sums[f] = f === "jobs" ? sums[f] : Math.round(sums[f] * 10) / 10;
        const pct =
          g.rows === 1 && g.only && (typeof g.only.percentBooked === "number" || g.only.percentBooked === null)
            ? g.only.percentBooked
            : percentBooked(g.sums.jobHours, g.sums.shiftHours, g.sums.availableHours);
        return { values: g.values, rows: g.rows, sums, percentBooked: pct };
      })
      .sort((a, b) => b.sums.jobHours - a.sums.jobHours || a.values.join("\u0000").localeCompare(b.values.join("\u0000")));
  }

  /** Both group and business_unit rows were summed; a group already includes its member units. */
  mixesTypes(): boolean {
    return this.types.size > 1;
  }
}
