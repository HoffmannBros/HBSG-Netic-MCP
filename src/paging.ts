import { MAX_PAGE_SIZE, NeticApiError, NeticRequestError, type Envelope, type NeticClient, type QueryParams, type Row } from "./client.js";
import { halveRange, inclusiveDays, splitRange } from "./dates.js";
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

function emptyWalk(): WalkResult {
  return { rows: [], matched: 0, scanned: 0, totalRecords: 0, pages: 0, hasMore: false, extras: {} };
}

/**
 * Walk the `{data, pagination}` envelope from page 1 until the API says
 * `hasMore: false` or `maxRows` matching rows are in hand.
 */
export async function walkPages(client: NeticClient, path: string, params: QueryParams, opts: WalkOptions): Promise<WalkResult> {
  const out = emptyWalk();
  await walkInto(client, path, params, opts, out);
  return out;
}

/** walkPages, filling `out` page by page so a caller still has what came before a failed page. */
async function walkInto(client: NeticClient, path: string, params: QueryParams, opts: WalkOptions, out: WalkResult): Promise<void> {
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(opts.pageSize)));
  for (let page = 1; ; page += 1) {
    const env = await client.getPage(path, { ...params, page, pageSize });
    if (page === 1) out.extras = envelopeExtras(env);
    out.pages += 1;
    out.totalRecords = env.pagination.totalRecords ?? out.totalRecords;
    out.scanned += env.data.length;
    const room = opts.maxRows - out.matched;
    const hits = opts.filter ? env.data.filter(opts.filter) : env.data;
    const kept = hits.length > room ? hits.slice(0, room) : hits;
    out.matched += kept.length;
    if (opts.onRows) {
      if (kept.length > 0) await opts.onRows(kept);
    } else {
      out.rows.push(...kept);
    }
    const apiHasMore = env.pagination.hasMore === true && env.data.length > 0;
    if (hits.length > kept.length) {
      out.hasMore = true;
      break;
    }
    if (!apiHasMore) break;
    if (out.matched >= opts.maxRows) {
      out.hasMore = true;
      break;
    }
  }
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
  /**
   * Date windows walked to the end (or to `maxRows`). A window split after a
   * server error is not counted itself; its halves are. `scanned`, `pages`, and
   * `totalRecords` cover these windows only, never a failed attempt.
   */
  chunks: number;
  /**
   * Date windows the range was split into: by `maxRangeDays` up front, plus one
   * for each window split in two after a server error. When above `chunks`, the
   * walk stopped early and totalRecords covers only the windows walked.
   */
  chunksPlanned: number;
  /** Rows dropped because an earlier chunk already returned them. */
  duplicates: number;
  /** Windows that returned a server error and were split in half and retried. */
  splitAfterError: number;
  /**
   * Rows a failed window had already returned (and kept or streamed) before
   * its error, dropped when its halves returned them again. Not duplicates in
   * the data, and not in `duplicates`.
   */
  repeatsDropped: number;
}

/**
 * Statuses that make walkRange split a window, on reports with `maxRangeDays`.
 * 500: live 2026-11-05 and 2026-11-11, utilization over some 14-day windows
 * fails every time while each 7-day half succeeds, so it tracks the work per
 * request. 502 and 504 reach here only after the client's own retries and are
 * the gateway's form of the same timeout. 503 says the service is down, which
 * smaller requests do not fix.
 */
const SPLIT_STATUSES = new Set([500, 502, 504]);

/**
 * Walk a report over start..end (inclusive). Endpoints with a per-request
 * range limit (utilization: 31 days) are split into consecutive chunks that
 * share `maxRows`, the filter, and `onRows`, with duplicate rows dropped. On
 * those endpoints a window that fails with a server error is halved and its
 * halves walked in its place, down to one day; a one-day failure is thrown.
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
  const planned = info.maxRangeDays ? splitRange(start, end, info.maxRangeDays) : [{ start, end }];
  const dedupe = planned.length > 1;
  const seen = new Set<string>();
  // Keys of rows a failed window already kept. Its halves return them again;
  // they were already pushed or streamed and cannot be taken back, so the
  // repeat is dropped instead.
  const replay = new Set<string>();
  // Per attempt, so a window that fails and is walked again in halves is not counted twice.
  let attemptKeys: string[] = [];
  let attemptDuplicates = 0;
  let attemptRepeats = 0;
  const key = info.maxRangeDays ? info.rowKey : undefined;
  const fresh = key
    ? (row: Row) => {
        const k = key(row);
        if (replay.delete(k)) {
          attemptRepeats += 1;
          attemptKeys.push(k);
          return false;
        }
        if (dedupe) {
          if (seen.has(k)) {
            attemptDuplicates += 1;
            return false;
          }
          seen.add(k);
        }
        attemptKeys.push(k);
        return true;
      }
    : undefined;
  const user = opts.filter;
  const filter = fresh && user ? (r: Row) => user(r) && fresh(r) : (fresh ?? user);
  const total: RangeWalkResult = {
    ...emptyWalk(),
    chunks: 0,
    chunksPlanned: planned.length,
    duplicates: 0,
    splitAfterError: 0,
    repeatsDropped: 0,
  };
  let haveExtras = false;
  const queue = [...planned];
  while (queue.length > 0) {
    const w = queue.shift()!;
    const r = emptyWalk();
    attemptKeys = [];
    attemptDuplicates = 0;
    attemptRepeats = 0;
    let failure: unknown;
    try {
      await walkInto(
        client,
        info.path,
        { ...params, [info.dateParams.start]: w.start, [info.dateParams.end]: w.end },
        { ...opts, maxRows: opts.maxRows - total.matched, filter },
        r,
      );
    } catch (err) {
      failure = err;
    }
    // Rows already kept from a failed window's earlier pages stay: with onRows they are gone.
    total.rows.push(...r.rows);
    total.matched += r.matched;
    if (!haveExtras && r.pages > 0) {
      total.extras = r.extras;
      haveExtras = true;
    }
    if (failure !== undefined) {
      if (!info.maxRangeDays || !(failure instanceof NeticApiError) || !SPLIT_STATUSES.has(failure.status)) throw failure;
      if (w.start === w.end) {
        const after = total.splitAfterError > 0 ? `, after ${total.splitAfterError} longer window(s) failed and were split` : "";
        failure.message = `${failure.message} Failed for the single day ${w.start}${after}; it cannot be split further.`;
        throw failure;
      }
      for (const k of attemptKeys) replay.add(k);
      queue.unshift(...halveRange(w.start, w.end));
      total.splitAfterError += 1;
      total.chunksPlanned += 1;
      continue;
    }
    total.chunks += 1;
    total.duplicates += attemptDuplicates;
    total.repeatsDropped += attemptRepeats;
    total.scanned += r.scanned;
    total.totalRecords += r.totalRecords;
    total.pages += r.pages;
    if (r.hasMore || (total.matched >= opts.maxRows && queue.length > 0)) {
      total.hasMore = true;
      break;
    }
  }
  return total;
}

/** Footer notes for a range walk: how it was split and what that means for the totals. */
export function rangeNotes(r: RangeWalkResult, maxRangeDays: number | undefined): string[] {
  const notes: string[] = [];
  const upFront = r.chunksPlanned - r.splitAfterError;
  if (r.chunks < r.chunksPlanned) {
    notes.push(`range split into ${r.chunksPlanned} requests of up to ${maxRangeDays} days; stopped after ${r.chunks}, so totalRecords covers only those`);
  } else if (upFront > 1) {
    notes.push(`range split into ${upFront} requests of up to ${maxRangeDays} days`);
  }
  if (r.splitAfterError > 0) {
    const repeats = r.repeatsDropped > 0 ? `; ${r.repeatsDropped} row(s) returned before an error were not repeated` : "";
    notes.push(`Netic returned a server error for ${r.splitAfterError} window(s); each was split into shorter windows and retried${repeats}`);
  }
  if (r.duplicates > 0) notes.push(`${r.duplicates} duplicate row(s) dropped`);
  return notes;
}

/** One page by hand; refused when the range needs splitting, since page numbers are per request. */

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
  return { ...r, chunks: 1, chunksPlanned: 1, duplicates: 0, splitAfterError: 0, repeatsDropped: 0 };
}
