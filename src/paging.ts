import { MAX_PAGE_SIZE, type NeticClient, type QueryParams, type Row } from "./client.js";

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
  for (let page = 1; ; page += 1) {
    const env = await client.getPage(path, { ...params, page, pageSize });
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
  return { rows, matched, scanned, totalRecords, pages, hasMore };
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
  };
}
