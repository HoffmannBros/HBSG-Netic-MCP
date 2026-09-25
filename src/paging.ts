import { MAX_PAGE_SIZE, NeticRequestError, type Envelope, type NeticClient, type QueryParams, type Row } from "./client.js";
import { inclusiveDays, splitRange } from "./dates.js";
import { REPORT_INFO, type Report } from "./endpoints.js";

export interface WalkOptions {
  /** Rows per request, 1 to 5000. */
  pageSize: number;
  /** Stop once this many matching rows are collected. `Infinity` walks every page. */
  maxRows: number;
  /** Client-side row filter; rows it rejects are scanned but not kept. */
  filter?: ((row: Row) => boolean) | undefined;
  /** Receive matching rows page by page instead of accumulating them (exports, counts). */
  onRows?: ((rows: Row[]) => Promise<void> | void) | undefined;
}

export interface WalkResult {
  /** Matching rows kept, empty when `onRows` is used. */
  rows: Row[];
  /** Matching rows seen, whether kept or streamed. */
  matched: number;
  /** Rows the API returned before filtering. */
  scanned: number;
  /** `pagination.totalRecords` from the API: rows in the range before any client filter. */
  totalRecords: number;
  pages: number;
  /** True when rows exist that this walk did not return. */
  hasMore: boolean;
  /** Envelope fields beside data and pagination (utilization: timeZone, snapshotAt), from the first page. */
  extras: Record<string, unknown>;
}

function envelopeExtras(env: Envelope): Record<string, unknown> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k !== "data" && k !== "pagination"));
}

/**
 * Walk the `{data, pagination}` envelope from page 1 until the API says
 * `hasMore: false` or `maxRows` matching rows are in hand.
 */
export async function walkPages(client: NeticClient, path: string, params: QueryParams, opts: WalkOptions): Promise<WalkResult> {
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(opts.pageSize)));
  const rows: Row[] = [];
  let matched = 0;
  let scanned = 0;
  let totalRecords = 0;
  let pages = 0;
  let hasMore = false;
  let extras: Record<string, unknown> = {};
  for (let page = 1; ; page += 1) {
    const env = await client.getPage(path, { ...params, page, pageSize });
    if (page === 1) extras = envelopeExtras(env);
    pages += 1;
    totalRecords = env.pagination.totalRecords ?? totalRecords;
    scanned += env.data.length;
    const room = opts.maxRows - matched;
    const hits = opts.filter ? env.data.filter(opts.filter) : env.data;
    const kept = hits.length > room ? hits.slice(0, room) : hits;
    matched += kept.length;
    if (opts.onRows) {
      if (kept.length > 0) await opts.onRows(kept);
    } else {
      rows.push(...kept);
    }
    const apiHasMore = env.pagination.hasMore === true && env.data.length > 0;
    if (hits.length > kept.length) {
      hasMore = true;
      break;
    }
    if (!apiHasMore) break;
    if (matched >= opts.maxRows) {
      hasMore = true;
      break;
    }
  }
  return { rows, matched, scanned, totalRecords, pages, hasMore, extras };
}

/** Fetch exactly one page, for callers that page by hand. */
export async function singlePage(client: NeticClient, path: string, params: QueryParams, page: number, pageSize: number, filter?: (row: Row) => boolean): Promise<WalkResult> {
  const env = await client.getPage(path, { ...params, page, pageSize });
  const rows = filter ? env.data.filter(filter) : env.data;
  return {
    rows,
    matched: rows.length,
    scanned: env.data.length,
    totalRecords: env.pagination.totalRecords ?? env.data.length,
    pages: 1,
    hasMore: env.pagination.hasMore === true,
    extras: envelopeExtras(env),
  };
}

export interface RangeWalkResult extends WalkResult {
  /** Date windows walked; more than one when the range was split. */
  chunks: number;
  /** Date windows the range was split into. When above `chunks`, totalRecords covers only the windows walked. */
  chunksPlanned: number;
  /** Rows dropped because an earlier chunk already returned them. */
  duplicates: number;
}

/**
 * Walk a report over start..end (inclusive). Endpoints with a per-request
 * range limit (utilization: 31 days) are split into consecutive chunks that
 * share `maxRows`, the filter, and `onRows`, with duplicate rows dropped.
 */
export async function walkRange(
  client: NeticClient,
  report: Report,
  params: QueryParams,
  start: string,
  end: string,
  opts: WalkOptions,
): Promise<RangeWalkResult> {
  const info = REPORT_INFO[report];
  const chunks = info.maxRangeDays ? splitRange(start, end, info.maxRangeDays) : [{ start, end }];
  const seen = new Set<string>();
  let duplicates = 0;
  const key = chunks.length > 1 ? info.rowKey : undefined;
  const fresh = key
    ? (row: Row) => {
        const k = key(row);
        if (seen.has(k)) {
          duplicates += 1;
          return false;
        }
        seen.add(k);
        return true;
      }
    : undefined;
  const user = opts.filter;
  const filter = fresh && user ? (r: Row) => fresh(r) && user(r) : (fresh ?? user);
  const total: RangeWalkResult = { rows: [], matched: 0, scanned: 0, totalRecords: 0, pages: 0, hasMore: false, extras: {}, chunks: 0, chunksPlanned: chunks.length, duplicates: 0 };
  for (const [i, chunk] of chunks.entries()) {
    const r = await walkPages(
      client,
      info.path,
      { ...params, [info.dateParams.start]: chunk.start, [info.dateParams.end]: chunk.end },
      { ...opts, maxRows: opts.maxRows - total.matched, filter },
    );
    total.chunks += 1;
    total.rows.push(...r.rows);
    total.matched += r.matched;
    total.scanned += r.scanned;
    total.totalRecords += r.totalRecords;
    total.pages += r.pages;
    if (i === 0) total.extras = r.extras;
    if (r.hasMore || (total.matched >= opts.maxRows && i < chunks.length - 1)) {
      total.hasMore = true;
      break;
    }
  }
  total.duplicates = duplicates;
  return total;
}

/** One page by hand; refused when the range needs splitting, since page numbers are per request. */
/** Footer notes for a range walk: how it was split and what that means for the totals. */
export function rangeNotes(r: RangeWalkResult, maxRangeDays: number | undefined): string[] {
  const notes: string[] = [];
  if (r.chunksPlanned > 1) {
    notes.push(
      r.chunks < r.chunksPlanned
        ? `range split into ${r.chunksPlanned} requests of up to ${maxRangeDays} days; stopped after ${r.chunks}, so totalRecords covers only those`
        : `range split into ${r.chunks} requests of up to ${maxRangeDays} days`,
    );
  }
  if (r.duplicates > 0) notes.push(`${r.duplicates} duplicate row(s) dropped`);
  return notes;
}

export async function singleRangePage(
  client: NeticClient,
  report: Report,
  params: QueryParams,
  start: string,
  end: string,
  page: number,
  pageSize: number,
  filter?: (row: Row) => boolean,
): Promise<RangeWalkResult> {
  const info = REPORT_INFO[report];
  if (info.maxRangeDays && inclusiveDays(start, end) > info.maxRangeDays) {
    throw new NeticRequestError(
      `page cannot be combined with a range over ${info.maxRangeDays} days for ${info.label}, because the range is split into several requests. Narrow the range or drop page to auto-page.`,
    );
  }
  const r = await singlePage(client, info.path, params, page, pageSize, filter);
  return { ...r, chunks: 1, chunksPlanned: 1, duplicates: 0 };
}
