import type { NeticClient, Row } from "../client.js";
import { walkRange, type RangeWalkResult } from "../paging.js";
import { RowScan, wherePredicate, type ColumnSource, type Where } from "../rows.js";
import { SCORECARD_ITEM_COLUMNS, scorecardItemRows } from "../scorecard.js";
import { reportParams } from "./common.js";

/** Derived report for count and export: one row per applicable scorecard item of an outbound call. */
export const SCORECARD_REPORT = "outbound_scorecard_items";
export const SCORECARD_LABEL = "outbound scorecard items";

export interface ScorecardItemsArgs {
  start: string;
  end: string;
  agent_ids?: Array<string | number> | undefined;
  where?: Where | undefined;
  max_rows: number;
}

export interface ScorecardItemsWalk {
  /** The walk over outbound calls; totalRecords and scanned count calls. */
  walked: RangeWalkResult;
  /** Item rows built, before where. */
  items: number;
  /** Item rows that passed where and went to onItems. */
  matched: number;
  source: ColumnSource;
  apiCalls: number;
}

/**
 * Walk outbound calls and stream their applicable scorecard items, with
 * where applied to the item rows. max_rows caps the calls scanned.
 */
export async function walkScorecardItems(client: NeticClient, args: ScorecardItemsArgs, onItems: (rows: Row[]) => Promise<void> | void): Promise<ScorecardItemsWalk> {
  const filter = wherePredicate(args.where);
  const scan = new RowScan("outbound_calls");
  let items = 0;
  let matched = 0;
  const before = client.requestCount;
  const walked = await walkRange(client, "outbound_calls", reportParams("outbound_calls", args), args.start, args.end, {
    pageSize: 5000,
    maxRows: args.max_rows,
    filter: scan.filter,
    onRows: async (calls) => {
      const built = calls.flatMap(scorecardItemRows);
      items += built.length;
      const kept = filter ? built.filter(filter) : built;
      matched += kept.length;
      if (kept.length > 0) await onItems(kept);
    },
  });
  const known = new Set<string>(SCORECARD_ITEM_COLUMNS);
  return {
    walked,
    items,
    matched,
    source: { scanned: items, has: (n) => known.has(n), columns: () => [...SCORECARD_ITEM_COLUMNS] },
    apiCalls: client.requestCount - before,
  };
}
