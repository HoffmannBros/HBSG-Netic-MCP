import type { Row } from "./client.js";
import { REPORT_INFO, TRANSCRIPT_COLUMNS, type Report } from "./endpoints.js";
import { addScorecardColumns } from "./scorecard.js";

export type Where = Record<string, string | string[]>;

export const BLANK = "(blank)";

/** Group and filter key for a cell: null, undefined, and "" all read as blank. */
export function cellKey(value: unknown): string {
  if (value === null || value === undefined || value === "") return BLANK;
  return typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * Equality filter, case-insensitive. An array matches any of its values;
 * "" or "(blank)" matches an empty cell. Fields combine with AND.
 */
export function wherePredicate(where: Where | undefined): ((row: Row) => boolean) | undefined {
  if (!where) return undefined;
  const entries = Object.entries(where).map(([field, raw]) => {
    const wanted = (Array.isArray(raw) ? raw : [raw]).map((v) => (v === "" ? BLANK : v).toLowerCase());
    return [field, new Set(wanted)] as const;
  });
  if (entries.length === 0) return undefined;
  return (row) => entries.every(([field, wanted]) => wanted.has(cellKey(row[field]).toLowerCase()));
}

export function project(row: Row, fields: string[]): Row {
  const out: Row = {};
  for (const f of fields) out[f] = row[f];
  return out;
}

export function dropColumns(row: Row, columns: readonly string[]): Row {
  const out: Row = { ...row };
  for (const c of columns) delete out[c];
  return out;
}

/** Keep outbound transcripts only when asked; they flood the context. */
export function stripTranscripts(rows: Row[], report: Report, include: boolean): Row[] {
  if (report !== "outbound_calls" || include) return rows;
  return rows.map((r) => dropColumns(r, TRANSCRIPT_COLUMNS));
}

/** Columns computed from other columns, added to every scanned row of a report. */
export function deriveColumns(report: string, row: Row): void {
  if (report === "outbound_calls") addScorecardColumns(row);
}

const hasOwn = (row: Row, key: string) => Object.prototype.hasOwnProperty.call(row, key);

/** What a warning needs to know about the rows a tool looked at. */
export interface ColumnSource {
  /** Rows looked at, including rows a filter rejected. */
  scanned: number;
  /** Whether any scanned row has this key (blank values count). */
  has(name: string): boolean;
  /** Columns seen, in first-seen order. */
  columns(): string[];
}

/**
 * The walk's filter hook, which sees every row the API returns: derives
 * computed columns (outbound qa_*) in place so where, group_by, and fields can
 * use them, records which columns exist, then applies where and any extra
 * predicate. Watched names are checked on every row until found; the column
 * list is sampled, since row shapes are uniform within a report.
 */
export class RowScan implements ColumnSource {
  scanned = 0;
  readonly filter: (row: Row) => boolean;
  /** True when where or the extra predicate can drop rows. */
  readonly filtered: boolean;
  private readonly seen = new Set<string>();
  private readonly pending: Set<string>;

  constructor(report: string, opts: { where?: Where | undefined; extra?: ((row: Row) => boolean) | undefined; watch?: Array<string | undefined> | undefined } = {}) {
    const whereFn = wherePredicate(opts.where);
    const extra = opts.extra;
    const user = whereFn && extra ? (r: Row) => whereFn(r) && extra(r) : (whereFn ?? extra);
    this.filtered = user !== undefined;
    this.pending = new Set([...Object.keys(opts.where ?? {}), ...(opts.watch ?? [])].filter((n): n is string => !!n));
    this.filter = (row) => {
      deriveColumns(report, row);
      this.scanned += 1;
      if (this.scanned <= 100 || this.scanned % 100 === 0) for (const k of Object.keys(row)) this.seen.add(k);
      for (const name of this.pending) {
        if (hasOwn(row, name)) {
          this.seen.add(name);
          this.pending.delete(name);
        }
      }
      return user ? user(row) : true;
    };
  }

  has(name: string): boolean {
    return this.seen.has(name);
  }

  columns(): string[] {
    return [...this.seen];
  }
}

/** A ColumnSource over rows already in hand (derived reports). */
export function columnsOf(rows: Row[], scanned = rows.length): ColumnSource {
  const set = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) set.add(k);
  return { scanned, has: (n) => set.has(n), columns: () => [...set] };
}

export interface ColumnChecks {
  fields?: string[] | undefined;
  where?: Where | undefined;
  groupBy?: string[] | undefined;
  value?: string | undefined;
  /** Names the tool adds after scanning (e.g. board, qa_items), never unknown. */
  added?: readonly string[] | undefined;
}

/**
 * Warnings for column names that no scanned row has. An empty scan proves
 * nothing, so it yields none.
 */
export function columnWarnings(src: ColumnSource, c: ColumnChecks): string[] {
  if (src.scanned === 0) return [];
  const added = new Set(c.added ?? []);
  const unknown = (names: string[] | undefined) => [...new Set(names ?? [])].filter((n) => !src.has(n) && !added.has(n));
  const available = `Available columns: ${[...src.columns(), ...added].filter((v, i, a) => a.indexOf(v) === i).join(", ")}.`;
  const scope = `any of the ${src.scanned} scanned row(s)`;
  const out: string[] = [];
  const fields = unknown(c.fields);
  if (fields.length > 0) out.push(`fields not in ${scope}: ${fields.join(", ")}, so those columns are blank. Names are case-sensitive. ${available}`);
  const where = unknown(Object.keys(c.where ?? {}));
  if (where.length > 0) {
    out.push(
      `where column(s) not in ${scope}: ${where.join(", ")}. A missing column reads as blank, so that filter matched no rows (or every row, for a "" value). ${available}`,
    );
  }
  const groupBy = unknown(c.groupBy);
  if (groupBy.length > 0) {
    out.push(`group_by column(s) not in ${scope}: ${groupBy.join(", ")}, so every row groups as ${BLANK}. Names are case-sensitive and vary by booking provider. ${available}`);
  }
  const value = unknown(c.value ? [c.value] : []);
  if (value.length > 0) out.push(`value column not in ${scope}: ${value[0]}, so there is nothing to average. ${available}`);
  return out;
}

function allColumns(rows: Row[]): string[] {
  const set = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) set.add(key);
  return [...set];
}

/**
 * Columns to show inline: the caller's `fields`, else the report's default
 * columns that are actually present (row shapes vary by booking provider),
 * else everything.
 */
export function inlineColumns(rows: Row[], report: Report, fields: string[] | undefined): { columns: string[]; available: string[] } {
  const available = allColumns(rows);
  if (fields && fields.length > 0) return { columns: fields, available };
  const present = new Set(available);
  const defaults = REPORT_INFO[report].defaultColumns.filter((c) => present.has(c));
  return { columns: defaults.length >= 3 ? defaults : available, available };
}
