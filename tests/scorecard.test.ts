import { describe, expect, it } from "vitest";
import { parseScorecard, scorecardColumns, scorecardItemRows, scorecardItems, addScorecardColumns, QA_COLUMNS, SCORECARD_ITEM_COLUMNS } from "../src/scorecard.js";
import { ANALYSIS } from "./scorecard-fixture.js";

describe("parseScorecard", () => {
  it("reads the score, flags, and every item", () => {
    const s = parseScorecard(ANALYSIS);
    expect(s).toMatchObject({ score: 0.6, isLead: true, isBooked: false, isFlagged: true, isExcused: false });
    expect(s?.items).toHaveLength(3);
    expect(s?.items[1]).toEqual({ section: "Options Were Reviewed", item: "Confirm Options and Pricing Were Reviewed", score: null, reason: "Invented reason two.", notApplicable: true });
  });

  it("accepts an already-parsed object", () => {
    expect(parseScorecard(JSON.parse(ANALYSIS))?.score).toBe(0.6);
  });

  it("returns undefined for blank, malformed, and non-object analysis, without throwing", () => {
    for (const bad of ["", "   ", "{not json", "null", "[1,2]", "42", null, undefined, 7]) {
      expect(parseScorecard(bad)).toBeUndefined();
    }
  });

  it("tolerates missing or odd sections and values", () => {
    const s = parseScorecard(JSON.stringify({ aggregate_score: "0.5", is_flagged: "yes", sections: [null, { name: "S", parameters: "x" }, { parameters: [{ score: "n/a" }] }] }));
    expect(s).toMatchObject({ score: 0.5, isFlagged: null, isLead: null });
    expect(s?.items).toEqual([{ section: "", item: "", score: null, reason: "", notApplicable: false }]);
  });
});

describe("scorecard columns", () => {
  it("flattens the scorecard into the qa_* columns", () => {
    expect(scorecardColumns(ANALYSIS)).toEqual({
      qa_score: 0.6,
      qa_is_lead: true,
      qa_is_booked: false,
      qa_is_flagged: true,
      qa_is_excused: false,
      qa_scored_items: 2,
      qa_na_items: 1,
    });
  });

  it("gives every qa_* column as null when there is no scorecard", () => {
    const cols = scorecardColumns("");
    expect(Object.keys(cols)).toEqual([...QA_COLUMNS]);
    expect(Object.values(cols).every((v) => v === null)).toBe(true);
    expect(scorecardColumns("{oops").qa_score).toBeNull();
  });

  it("adds the columns to a row in place, once", () => {
    const row: Record<string, unknown> = { id: "c1", analysis: ANALYSIS };
    addScorecardColumns(row);
    expect(row.qa_score).toBe(0.6);
    row.analysis = "";
    addScorecardColumns(row);
    expect(row.qa_score).toBe(0.6);
  });

  it("lists only applicable items for include_scorecard", () => {
    expect(scorecardItems(ANALYSIS)).toEqual([
      { section: "Options Were Reviewed", item: "Make Clear the Decision Is the Customer's", score: 0.6, reason: "Invented reason one." },
      { section: "Recorded Line / All Parties Aware", item: "State the Line Is Recorded", score: 1, reason: "Invented reason three." },
    ]);
    expect(scorecardItems("not json")).toEqual([]);
  });

  it("builds one item row per applicable item with the call's columns", () => {
    const rows = scorecardItemRows({ call_placed_at: "2026-11-04T09:00:00-06:00", agent_name: "Agent One", agent_id: "11", service_titan_call_id: "900", job_id: "", analysis: ANALYSIS, transcript: "x" });
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0]!)).toEqual([...SCORECARD_ITEM_COLUMNS]);
    expect(rows[1]).toMatchObject({ agent_name: "Agent One", section: "Recorded Line / All Parties Aware", score: 1 });
    expect(scorecardItemRows({ analysis: "" })).toEqual([]);
  });
});
