import { describe, expect, it } from "vitest";
import { GroupCounter } from "../src/aggregate.js";
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
