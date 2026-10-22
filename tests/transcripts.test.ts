import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { csvLine } from "../src/csv.js";
import {
  TranscriptSourceError,
  attachTranscripts,
  buildMatcher,
  drilldownFromText,
  findDrilldownCsv,
  joinNotes,
  parseCsv,
  searchable,
  seededShuffle,
  snippets,
  transcriptFeatures,
  truncate,
  turns,
} from "../src/transcripts.js";

const HEADER = ["Tenant", "Phone Number", "Date", "Category", "Total Call Duration", "ServiceTitan Call ID", "AI Call Transcript"];

function drilldownCsv(rows: string[][], header = HEADER): string {
  return `﻿${[header, ...rows].map(csvLine).join("\r\n")}\r\n`;
}

describe("parseCsv", () => {
  it("handles a BOM, CRLF, quoted commas and newlines, and doubled quotes", () => {
    const text = '﻿a,b,c\r\n1,"x, y","line1\nline2"\r\n2,"say ""hi""",\r\n';
    expect(parseCsv(text)).toEqual([
      ["a", "b", "c"],
      ["1", "x, y", "line1\nline2"],
      ["2", 'say "hi"', ""],
    ]);
  });

  it("keeps a last row without a trailing newline", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("drilldownFromText", () => {
  it("reads the columns it needs and the date coverage", () => {
    const d = drilldownFromText(
      drilldownCsv([
        ["NASH Hoffmann", "+1", "09/02/2026 10:00", "Booked", "1:00", "7", "Agent: Hi\nUser: Help"],
        ["NASH Hoffmann", "+2", "08/31/2026 09:00", "Handled", "0:10", "", ""],
      ]),
      "f.csv",
    );
    expect(d.tenant).toBe("NASH Hoffmann");
    expect(d.rows).toHaveLength(2);
    expect(d.withTranscript).toBe(1);
    expect(d.first).toBe("08/31/2026 09:00");
    expect(d.last).toBe("09/02/2026 10:00");
    expect(d.rows[0]?.transcript).toBe("Agent: Hi\nUser: Help");
  });

  it("refuses the texts export, which has no transcript column", () => {
    expect(() => drilldownFromText(drilldownCsv([], HEADER.slice(0, -1)), "texts.csv")).toThrow(/only in the Calls Drill Down/);
  });

  it("refuses a file that mixes tenants", () => {
    const text = drilldownCsv([
      ["A", "+1", "09/02/2026 10:00", "", "", "", "x"],
      ["B", "+2", "09/02/2026 10:00", "", "", "", "y"],
    ]);
    expect(() => drilldownFromText(text, "f.csv")).toThrow(TranscriptSourceError);
  });
});

describe("attachTranscripts", () => {
  const drilldown = drilldownFromText(
    drilldownCsv([
      ["T", "+1", "09/10/2026 08:00", "", "1:00", "9001", "Agent: Hi\nUser: My AC broke"],
      ["T", "+2", "09/10/2026 09:00", "", "2:00", "9002", "Agent: Hi\nUser: Reschedule please"],
      ["T", "+2", "09/10/2026 09:00", "", "0:30", "9003", "Agent: Hi\nUser: Billing person please"],
      ["T", "+4", "09/10/2026 10:00", "", "0:05", "9004", ""],
      ["T", "+6", "09/10/2026 12:00", "", "1:00", "", "Agent: A"],
      ["T", "+6", "09/10/2026 12:00", "", "1:00", "", "Agent: B"],
    ]),
    "f.csv",
  );
  const api = [
    { id: "i0", phoneNumber: "+1", date: "09/10/2026 08:00", serviceTitanCallId: "9001", callDurationTotal: "1:00" },
    { id: "i2", phoneNumber: "+2", date: "09/10/2026 09:00", serviceTitanCallId: "9003", callDurationTotal: "0:30" },
    { id: "i1", phoneNumber: "+2", date: "09/10/2026 09:00", serviceTitanCallId: "9002", callDurationTotal: "2:00" },
    { id: "i3", phoneNumber: "+4", date: "09/10/2026 10:00", serviceTitanCallId: "9004", callDurationTotal: "0:05" },
    { id: "i4", phoneNumber: "+5", date: "09/10/2026 11:00", serviceTitanCallId: "9005", callDurationTotal: "1:00" },
    { id: "i5", phoneNumber: "+6", date: "09/10/2026 12:00", serviceTitanCallId: null, callDurationTotal: "1:00" },
  ];

  it("matches on phone and minute and breaks ties by ServiceTitan call id", () => {
    const { rows, stats } = attachTranscripts(api, drilldown);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.i0?.transcript).toContain("My AC broke");
    expect(byId.i1?.transcript).toContain("Reschedule");
    expect(byId.i2?.transcript).toContain("Billing");
    expect(byId.i0?.userTurns).toBe(1);
    expect(byId.i0?.firstUserLine).toBe("My AC broke");
    expect(stats).toMatchObject({ source: "csv", apiRows: 6, withTranscript: 3, matchedBlank: 1, unmatched: 1, ambiguous: 1 });
    expect(joinNotes(stats).join(" ")).toMatch(/1 matched with a blank transcript, 1 not in the CSV, 1 ambiguous/);
  });

  it("prefers a transcript the API itself sends and skips the CSV", () => {
    const { rows, stats } = attachTranscripts([{ id: "x", aiCallTranscript: "User: from the API" }, { id: "y" }], drilldown);
    expect(stats.source).toBe("api");
    expect(rows[0]?.transcript).toBe("User: from the API");
    expect(stats.withTranscript).toBe(1);
  });
});

describe("turns and features", () => {
  it("splits Agent and User turns, keeping unlabeled lead text", () => {
    expect(turns("Hello\nAgent: Hi there\nUser: Help me\nwith this\nAgent: OK")).toEqual([
      { speaker: "", text: "Hello" },
      { speaker: "Agent", text: "Hi there" },
      { speaker: "User", text: "Help me\nwith this" },
      { speaker: "Agent", text: "OK" },
    ]);
    expect(transcriptFeatures("Agent: a\nUser: b\nAgent: c")).toMatchObject({ agentTurns: 2, userTurns: 1, firstUserLine: "b" });
  });
});

describe("search", () => {
  const t = "Agent: Would you like a membership?\nUser: No membership, just a tune up please.\nAgent: Booked.";

  it("matches any or all terms, phrases, and regex", () => {
    const texts = [t];
    expect(buildMatcher("membership refund", { match: "any", regex: false }).matches(texts)).toBe(true);
    expect(buildMatcher("membership refund", { match: "all", regex: false }).matches(texts)).toBe(false);
    expect(buildMatcher('"tune up" booked', { match: "all", regex: false }).matches(texts)).toBe(true);
    expect(buildMatcher("tune\\s+up", { match: "any", regex: true }).matches(texts)).toBe(true);
    expect(() => buildMatcher("(", { match: "any", regex: true })).toThrow(/Invalid regex/);
  });

  it("limits the search to one speaker and labels snippets", () => {
    const m = buildMatcher("membership", { match: "any", regex: false });
    const user = searchable(t, "user");
    expect(user.map((p) => p.speaker)).toEqual(["User"]);
    const found = snippets(user, m, 40, 3);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^User: No membership, just/);
    expect(snippets(searchable(t, "any"), m, 40, 1)).toHaveLength(1);
  });
});

describe("truncate and sample", () => {
  it("keeps the head and tail", () => {
    const r = truncate("a".repeat(70) + "b".repeat(30), 50);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("a".repeat(35))).toBe(true);
    expect(r.text).toContain("[…]");
    expect(r.text.endsWith("b")).toBe(true);
    expect(truncate("short", 50)).toEqual({ text: "short", truncated: false });
  });

  it("shuffles the same way for the same seed", () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    expect(seededShuffle(items, 7)).toEqual(seededShuffle(items, 7));
    expect(seededShuffle(items, 7)).not.toEqual(items);
    expect([...seededShuffle(items, 7)].sort((a, b) => a - b)).toEqual(items);
  });
});

describe("findDrilldownCsv", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "netic-transcripts-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, text: string, ageMs: number) {
    const file = path.join(dir, name);
    await fs.writeFile(file, text);
    const when = new Date(Date.now() - ageMs);
    await fs.utimes(file, when, when);
    return file;
  }

  it("picks the newest calls export for the tenant, skipping texts exports and other tenants", async () => {
    const older = await write("drilldown_export_2026-09-29.csv", drilldownCsv([["NASH Hoffmann", "+1", "09/01/2026 08:00", "", "", "", "x"]]), 60_000);
    const newest = await write("drilldown_export_2026-09-30 (1).csv", drilldownCsv([["NASH Hoffmann", "+1", "09/01/2026 08:00", "", "", "", "x"]]), 30_000);
    await write("drilldown_export_2026-09-30.csv", drilldownCsv([["NASH Hoffmann", "+1", "09/01/2026 08:00", "", "", ""]], HEADER.slice(0, -1)), 1_000);
    await write("drilldown_export_2026-09-30 (2).csv", drilldownCsv([["STL Hoffmann", "+1", "09/01/2026 08:00", "", "", "", "x"]]), 0);
    expect(await findDrilldownCsv(dir, "NASH Hoffmann")).toBe(newest);
    expect(older).not.toBe(newest);
    await expect(findDrilldownCsv(dir, "Blue Sky")).rejects.toThrow(/1 without the transcript column \(texts exports\), 3 for another tenant/);
  });

  it("explains how to export when the folder is missing", async () => {
    await expect(findDrilldownCsv(path.join(dir, "nope"), "Blue Sky")).rejects.toThrow(/Drill Down for Calls/);
  });
});
