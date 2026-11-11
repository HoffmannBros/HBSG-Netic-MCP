import { describe, expect, it } from "vitest";
import { GroupAverager, GroupCounter, numericCell } from "../src/aggregate.js";
import { NeticClient, type Row } from "../src/client.js";
import { walkPages } from "../src/paging.js";

describe("GroupCounter", () => {
  it("counts by several fields, groups blanks, and sorts largest first", () => {
    const c = new GroupCounter(["category", "leadSource"]);
    c.addMany([
      { category: "Booked", leadSource: "google-lsa" },
      { category: "Booked", leadSource: "google-lsa" },
      { category: "Booked", leadSource: null },
      { category: "Not Booked", leadSource: "" },
      { category: "Booked", leadSource: "yelp" },
    ]);
    expect(c.total).toBe(5);
    expect(c.groups()).toEqual([
      { values: ["Booked", "google-lsa"], count: 2 },
      { values: ["Booked", "(blank)"], count: 1 },
      { values: ["Booked", "yelp"], count: 1 },
      { values: ["Not Booked", "(blank)"], count: 1 },
    ]);
  });
});

describe("GroupAverager", () => {
  it("averages numbers and numeric strings per group, skipping blanks and text", () => {
    const a = new GroupAverager(["agent_name"], "qa_score");
    a.addMany([
      { agent_name: "A", qa_score: 0.5 },
      { agent_name: "A", qa_score: "1" },
      { agent_name: "A", qa_score: 0.25 },
      { agent_name: "A", qa_score: null },
      { agent_name: "B", qa_score: "" },
      { agent_name: "B", qa_score: "n/a" },
      { agent_name: "C", qa_score: 1 / 3 },
    ]);
    expect(a.total).toBe(7);
    expect(a.skipped).toBe(3);
    expect(a.groups()).toEqual([
      { values: ["A"], rows: 4, n: 3, avg: 0.583, min: 0.25, max: 1 },
      { values: ["B"], rows: 2, n: 0, avg: null, min: null, max: null },
      { values: ["C"], rows: 1, n: 1, avg: 0.333, min: 0.333, max: 0.333 },
    ]);
    // Over every value, not an average of group averages.
    expect(a.overall()).toEqual({ n: 4, avg: 0.521 });
  });

  it("averages string durations, as outbound calls send them", () => {
    const a = new GroupAverager(["agent_name"], "call_duration_seconds");
    a.addMany([
      { agent_name: "A", call_duration_seconds: "120" },
      { agent_name: "A", call_duration_seconds: " 60 " },
    ]);
    expect(a.groups()[0]).toMatchObject({ n: 2, avg: 90 });
  });
});

describe("numericCell", () => {
  it("reads numbers and numeric strings only", () => {
    expect([1.5, "2", " 3 ", "", " ", "x", null, undefined, true, Number.NaN, Infinity].map(numericCell)).toEqual([1.5, 2, 3, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
  });
});

/** A fake API holding `total` rows, paged the way the spec describes. */
function fakeApi(total: number) {
  const requests: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url);
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 100);
    const all: Row[] = Array.from({ length: total }, (_, i) => ({ id: String(i), kind: i % 3 === 0 ? "a" : "b" }));
    const data = all.slice((page - 1) * pageSize, page * pageSize);
    const totalPages = Math.ceil(total / pageSize);
    return new Response(JSON.stringify({ data, pagination: { page, pageSize, totalRecords: total, totalPages, hasMore: page < totalPages } }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const client = new NeticClient({ tenant: "blue", token: "t", baseUrl: "https://example.test", timeoutMs: 1000, fetchImpl });
  return { client, requests };
}

const path = "/api/public/metrics/bookings/referrer";
const params = { createdOnOrAfter: "2026-09-01", createdBefore: "2026-09-30" };

describe("walkPages", () => {
  it("walks every page until hasMore is false", async () => {
    const { client, requests } = fakeApi(250);
    const r = await walkPages(client, path, params, { pageSize: 100, maxRows: Number.POSITIVE_INFINITY });
    expect(r.rows).toHaveLength(250);
    expect(r.pages).toBe(3);
    expect(r.totalRecords).toBe(250);
    expect(r.hasMore).toBe(false);
    expect(requests.map((u) => u.searchParams.get("page"))).toEqual(["1", "2", "3"]);
  });

  it("stops at maxRows mid-page and reports hasMore", async () => {
    const { client, requests } = fakeApi(250);
    const r = await walkPages(client, path, params, { pageSize: 100, maxRows: 150 });
    expect(r.rows).toHaveLength(150);
    expect(r.hasMore).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it("reports hasMore when maxRows lands exactly on a page boundary with more pages left", async () => {
    const { client } = fakeApi(250);
    const r = await walkPages(client, path, params, { pageSize: 100, maxRows: 100 });
    expect(r.rows).toHaveLength(100);
    expect(r.hasMore).toBe(true);
  });

  it("does not report hasMore when the last row fills maxRows exactly", async () => {
    const { client } = fakeApi(100);
    const r = await walkPages(client, path, params, { pageSize: 100, maxRows: 100 });
    expect(r.hasMore).toBe(false);
  });

  it("filters client-side and streams to onRows without accumulating", async () => {
    const { client } = fakeApi(250);
    const seen: Row[] = [];
    const r = await walkPages(client, path, params, {
      pageSize: 100,
      maxRows: Number.POSITIVE_INFINITY,
      filter: (row) => row.kind === "a",
      onRows: (rows) => void seen.push(...rows),
    });
    expect(r.rows).toEqual([]);
    expect(r.matched).toBe(84);
    expect(seen).toHaveLength(84);
    expect(r.scanned).toBe(250);
  });

  it("handles an empty range in one request", async () => {
    const { client, requests } = fakeApi(0);
    const r = await walkPages(client, path, params, { pageSize: 5000, maxRows: 10 });
    expect(r.rows).toEqual([]);
    expect(r.hasMore).toBe(false);
    expect(requests).toHaveLength(1);
  });
});
