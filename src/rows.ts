import type { Row } from "./client.js";
import { REPORT_INFO, TRANSCRIPT_COLUMNS, type Report } from "./endpoints.js";

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
