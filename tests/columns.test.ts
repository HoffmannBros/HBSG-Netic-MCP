import { describe, expect, it } from "vitest";
import type { Row } from "../src/client.js";
import { RowScan, columnWarnings, columnsOf, stripTranscripts } from "../src/rows.js";
import { ANALYSIS } from "./scorecard-fixture.js";

describe("RowScan", () => {
  it("derives the qa_* columns on outbound rows, so they survive transcript stripping", () => {
    const scan = new RowScan("outbound_calls", { where: { qa_is_flagged: "true" } });
    const rows: Row[] = [
      { id: "c1", agent_name: "Agent One", transcript: "Customer: hi\nCXR: hello", analysis: ANALYSIS },
      { id: "c2", agent_name: "Agent Two", transcript: "Customer: hi", analysis: "" },
    ];
    const kept = rows.filter(scan.filter);
    expect(kept.map((r) => r.id)).toEqual(["c1"]);
    const [stripped] = stripTranscripts(kept, "outbound_calls", false);
    expect(stripped).not.toHaveProperty("transcript");
    expect(stripped).not.toHaveProperty("analysis");
    expect(stripped).toMatchObject({ qa_score: 0.6, qa_is_flagged: true, qa_scored_items: 2, qa_na_items: 1 });
    expect(rows[1]).toMatchObject({ qa_score: null, qa_is_flagged: null });
  });

  it("leaves other reports' rows alone", () => {
    const scan = new RowScan("interactions");
    const row: Row = { id: "i1", analysis: ANALYSIS };
    expect(scan.filter(row)).toBe(true);
    expect(row).not.toHaveProperty("qa_score");
    expect(scan.filtered).toBe(false);
  });

  it("records columns of rows the filter rejected, and watched names found on any row", () => {
    const scan = new RowScan("interactions", { where: { category: "Booked" }, watch: ["rare"] });
    const rows: Row[] = Array.from({ length: 450 }, (_, i) => ({ id: String(i), category: "Not Booked", ...(i === 333 ? { rare: "" } : {}) }));
    expect(rows.filter(scan.filter)).toHaveLength(0);
    expect(scan.scanned).toBe(450);
    expect(scan.filtered).toBe(true);
    expect(scan.has("category")).toBe(true);
    // Row 333 is outside the sample, but a watched name is checked on every row.
    expect(scan.has("rare")).toBe(true);
    expect(scan.has("nope")).toBe(false);
    expect(scan.columns()).toEqual(["id", "category", "rare"]);
  });

  it("does not mistake inherited properties for columns", () => {
    const scan = new RowScan("interactions", { watch: ["toString"] });
    scan.filter({ id: "1" });
    expect(scan.has("toString")).toBe(false);
  });
});

describe("columnWarnings", () => {
  const src = columnsOf([{ category: "Booked", leadSource: null, trade: "HVAC" }]);

  it("names unknown fields, where keys, group_by columns, and value, with the available columns", () => {
    const w = columnWarnings(src, { fields: ["category", "Category"], where: { categroy: "Booked" }, groupBy: ["trade", "lead_source"], value: "score" });
    expect(w).toHaveLength(4);
    expect(w[0]).toMatch(/^fields not in any of the 1 scanned row\(s\): Category, so those columns are blank\..*Available columns: category, leadSource, trade\./);
    expect(w[1]).toMatch(/^where column\(s\) not in .*: categroy\. A missing column reads as blank/);
    expect(w[2]).toMatch(/^group_by column\(s\) not in .*: lead_source, so every row groups as \(blank\)/);
    expect(w[3]).toMatch(/^value column not in .*: score/);
  });

  it("treats a column that exists but is blank as known", () => {
    expect(columnWarnings(src, { groupBy: ["leadSource"], where: { leadSource: "" } })).toEqual([]);
  });

  it("accepts names the tool adds after scanning", () => {
    expect(columnWarnings(src, { fields: ["board"], added: ["board"] })).toEqual([]);
  });

  it("says nothing when no row was scanned, since that proves nothing", () => {
    expect(columnWarnings(columnsOf([]), { fields: ["x"], where: { y: "1" }, groupBy: ["z"] })).toEqual([]);
  });
});
