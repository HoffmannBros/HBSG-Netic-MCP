import type { Row } from "./client.js";

/**
 * Outbound call QA scorecards. Since 2026-11 Netic fills the outbound
 * `analysis` column with a JSON string: its AI grading of the human CSR's
 * call, an aggregate_score from 0 to 1, lead/booked/flagged/excused flags,
 * and sections of scored items (docs/netic-api.md, 2026-11-11). It can also
 * be blank or malformed, so nothing here throws.
 */

export interface ScorecardItem {
  section: string;
  item: string;
  /** 0 to 1, or null when Netic gave none. */
  score: number | null;
  reason: string;
  notApplicable: boolean;
}

export interface Scorecard {
  score: number | null;
  isLead: boolean | null;
  isBooked: boolean | null;
  isFlagged: boolean | null;
  isExcused: boolean | null;
  items: ScorecardItem[];
}

/** Flat columns derived on every outbound row, in this order. */
export const QA_COLUMNS = ["qa_score", "qa_is_lead", "qa_is_booked", "qa_is_flagged", "qa_is_excused", "qa_scored_items", "qa_na_items"] as const;

/** Columns of the derived outbound_scorecard_items report: one row per applicable item. */
export const SCORECARD_ITEM_COLUMNS = [
  "call_placed_at",
  "agent_name",
  "agent_id",
  "service_titan_call_id",
  "job_id",
  "section",
  "item",
  "score",
  "reason",
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function bool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The scorecard in an `analysis` cell (JSON string or object), or undefined when blank or unreadable. */
export function parseScorecard(analysis: unknown): Scorecard | undefined {
  let raw: unknown = analysis;
  if (typeof analysis === "string") {
    if (analysis.trim() === "") return undefined;
    try {
      raw = JSON.parse(analysis);
    } catch {
      return undefined;
    }
  }
  const a = record(raw);
  if (!a) return undefined;
  const items: ScorecardItem[] = [];
  for (const s of Array.isArray(a.sections) ? a.sections : []) {
    const section = record(s);
    if (!section) continue;
    for (const p of Array.isArray(section.parameters) ? section.parameters : []) {
      const param = record(p);
      if (!param) continue;
      items.push({
        section: text(section.name),
        item: text(param.name),
        score: num(param.score),
        reason: text(param.reason),
        notApplicable: param.not_applicable === true,
      });
    }
  }
  return {
    score: num(a.aggregate_score),
    isLead: bool(a.is_lead),
    isBooked: bool(a.is_booked),
    isFlagged: bool(a.is_flagged),
    isExcused: bool(a.is_excused),
    items,
  };
}

/** The qa_* columns for one analysis cell; all null when there is no readable scorecard. */
export function scorecardColumns(analysis: unknown): Record<(typeof QA_COLUMNS)[number], number | boolean | null> {
  const s = parseScorecard(analysis);
  return {
    qa_score: s?.score ?? null,
    qa_is_lead: s?.isLead ?? null,
    qa_is_booked: s?.isBooked ?? null,
    qa_is_flagged: s?.isFlagged ?? null,
    qa_is_excused: s?.isExcused ?? null,
    qa_scored_items: s ? s.items.filter((i) => !i.notApplicable && i.score !== null).length : null,
    qa_na_items: s ? s.items.filter((i) => i.notApplicable).length : null,
  };
}

/**
 * Add the qa_* columns to an outbound row in place, before any filter or
 * transcript stripping sees it. Rows that already carry them are left alone.
 */
export function addScorecardColumns(row: Row): void {
  if (Object.prototype.hasOwnProperty.call(row, "qa_score")) return;
  Object.assign(row, scorecardColumns(row.analysis));
}

/** Applicable items of a call, compact, for the include_scorecard column. */
export function scorecardItems(analysis: unknown): Array<{ section: string; item: string; score: number | null; reason: string }> {
  const s = parseScorecard(analysis);
  return s ? s.items.filter((i) => !i.notApplicable).map(({ section, item, score, reason }) => ({ section, item, score, reason })) : [];
}

/** One outbound_scorecard_items row per applicable item of a call. */
export function scorecardItemRows(call: Row): Row[] {
  return scorecardItems(call.analysis).map((i) => ({
    call_placed_at: call.call_placed_at,
    agent_name: call.agent_name,
    agent_id: call.agent_id,
    service_titan_call_id: call.service_titan_call_id,
    job_id: call.job_id,
    section: i.section,
    item: i.item,
    score: i.score,
    reason: i.reason,
  }));
}
