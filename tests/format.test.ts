import { describe, expect, it } from "vitest";
import { ZodError, z } from "zod";
import { NeticConfigError } from "../src/client.js";
import { DateError } from "../src/dates.js";
import { describeError, footer, formatCell, markdownTable } from "../src/format.js";
import { inlineColumns, stripTranscripts, wherePredicate } from "../src/rows.js";

describe("formatCell and markdownTable", () => {
  it("escapes pipes, flattens newlines, and truncates long text", () => {
    expect(formatCell("a|b\nc")).toBe("a\\|b c");
    expect(formatCell("x".repeat(300), 10)).toBe(`${"x".repeat(9)}…`);
    expect(formatCell(null)).toBe("");
    expect(formatCell(1.234567)).toBe("1.2346");
  });

  it("renders a table and says so when empty", () => {
    expect(markdownTable([], ["a"])).toBe("(no rows)");
    expect(markdownTable([{ a: 1, b: "x" }], ["a", "b"])).toBe("| a | b |\n| --- | --- |\n| 1 | x |");
  });
});

describe("footer", () => {
  const base = { tenant: "stl", label: "inbound interactions", start: "2026-09-01", end: "2026-09-07", apiCalls: 2 };

  it("shows tenant, inclusive range, rows of totalRecords, and hasMore", () => {
    const text = footer({ ...base, returned: 500, totalRecords: 1342, hasMore: true, moreHint: "Use netic_export." });
    expect(text).toContain("tenant stl");
    expect(text).toContain("2026-09-01 to 2026-09-07 (both inclusive");
    expect(text).toContain("500 of 1342 row(s)");
    expect(text).toContain("hasMore: true. Use netic_export.");
    expect(text).toContain("2 API call(s)");
  });

  it("reports matched and scanned rows when filtered", () => {
    const text = footer({ ...base, returned: 12, totalRecords: 300, scanned: 300, filtered: true, hasMore: false, moreHint: "x" });
    expect(text).toContain("12 matching row(s) from 300 scanned of 300 in range");
    expect(text).toContain("hasMore: false");
    expect(text).not.toContain(". x");
  });
});

describe("describeError", () => {
  it("passes our own errors through and summarizes zod issues", () => {
    expect(describeError(new DateError("bad date"))).toBe("bad date");
    expect(describeError(new NeticConfigError("no tenant"))).toBe("no tenant");
    const zerr = (() => {
      try {
        z.object({ a: z.number() }).parse({ a: "x" });
      } catch (e) {
        return e;
      }
    })();
    expect(zerr).toBeInstanceOf(ZodError);
    expect(describeError(zerr)).toMatch(/^Invalid arguments: a:/);
  });
});

describe("rows helpers", () => {
  it("filters by equality, case-insensitively, with any-of arrays and blanks", () => {
    const rows = [
      { category: "Booked", trade: "HVAC" },
      { category: "booked", trade: "Plumbing" },
      { category: "Not Booked", trade: "" },
      { category: "Booked", trade: null },
    ];
    expect(rows.filter(wherePredicate({ category: "BOOKED" })!)).toHaveLength(3);
    expect(rows.filter(wherePredicate({ category: "booked", trade: ["hvac", "plumbing"] })!)).toHaveLength(2);
    expect(rows.filter(wherePredicate({ trade: "" })!)).toHaveLength(2);
    expect(wherePredicate({})).toBeUndefined();
    expect(wherePredicate(undefined)).toBeUndefined();
  });

  it("uses the default columns that exist, else every column", () => {
    const st = [{ booked_at: "x", job_id: "1", technician_name: "t", extra: 1 }];
    expect(inlineColumns(st, "tgl_bookings", undefined).columns).toEqual(["booked_at", "job_id", "technician_name"]);
    const odd = [{ foo: 1, bar: 2 }];
    expect(inlineColumns(odd, "tgl_bookings", undefined).columns).toEqual(["foo", "bar"]);
    expect(inlineColumns(st, "tgl_bookings", ["extra"]).columns).toEqual(["extra"]);
  });

  it("drops transcripts from outbound calls unless asked", () => {
    const rows = [{ id: "1", transcript: "long", analysis: "{}", summary: "s" }];
    expect(stripTranscripts(rows, "outbound_calls", false)).toEqual([{ id: "1", summary: "s" }]);
    expect(stripTranscripts(rows, "outbound_calls", true)).toEqual(rows);
    expect(stripTranscripts(rows, "referrer_bookings", false)).toEqual(rows);
  });
});
