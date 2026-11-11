import { describe, expect, it } from "vitest";
import { NeticApiError, NeticClient, type Row } from "../src/client.js";
import { addDays, inclusiveDays } from "../src/dates.js";
import { rangeNotes, walkRange } from "../src/paging.js";

// Invented utilization rows: two business units per day.
function rowsFor(start: string, end: string): Row[] {
  const out: Row[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    for (const name of ["Unit A", "Unit B"]) out.push({ date: d, type: "business_unit", name, businessUnitId: name === "Unit A" ? 1 : 2, jobs: 1 });
  }
  return out;
}

interface Req {
  start: string;
  end: string;
  page: number;
}

/** A fake utilization API that pages rowsFor(start, end) and fails where `fails` says, with that status. */
function splitClient(fails: (w: Req) => number | undefined) {
  const requests: Req[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const req = { start: url.searchParams.get("startDate") ?? "", end: url.searchParams.get("endDate") ?? "", page: Number(url.searchParams.get("page")) };
    requests.push(req);
    const status = fails(req);
    if (status !== undefined) {
      return new Response(JSON.stringify({ error: "Failed to fetch utilization" }), { status, headers: { "content-type": "application/json" } });
    }
    const pageSize = Number(url.searchParams.get("pageSize"));
    const all = rowsFor(req.start, req.end);
    const data = all.slice((req.page - 1) * pageSize, req.page * pageSize);
    const body = {
      data,
      pagination: { page: req.page, pageSize, totalRecords: all.length, totalPages: Math.ceil(all.length / pageSize), hasMore: req.page * pageSize < all.length },
      timeZone: "America/Chicago",
      snapshotAt: null,
    };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new NeticClient({ tenant: "stl", token: "t", baseUrl: "https://example.test", timeoutMs: 1000, fetchImpl, sleep: async () => {} });
  return { client, requests };
}

const keyOf = (r: Row) => `${String(r.date)}|${String(r.name)}`;
const longerThan = (days: number, status = 500) => (w: Req) => (inclusiveDays(w.start, w.end) > days ? status : undefined);

describe("walkRange splits a utilization window after a server error", () => {
  it("walks a 14-day window that 500s as two 7-day halves, in order", async () => {
    const { client, requests } = splitClient(longerThan(7));
    const r = await walkRange(client, "utilization", {}, "2026-09-10", "2026-09-23", { pageSize: 5000, maxRows: Infinity });
    expect(requests.map((q) => [q.start, q.end])).toEqual([
      ["2026-09-10", "2026-09-23"],
      ["2026-09-10", "2026-09-16"],
      ["2026-09-17", "2026-09-23"],
    ]);
    expect(r.rows.map(keyOf)).toEqual(rowsFor("2026-09-10", "2026-09-23").map(keyOf));
    expect(r).toMatchObject({ matched: 28, scanned: 28, totalRecords: 28, pages: 2, hasMore: false, chunks: 2, chunksPlanned: 2, splitAfterError: 1, repeatsDropped: 0, duplicates: 0 });
    expect(r.extras).toEqual({ timeZone: "America/Chicago", snapshotAt: null });
    expect(rangeNotes(r, 31)).toEqual(["Netic returned a server error for 1 window(s); each was split into shorter windows and retried"]);
  });

  it("recurses until the windows pass, within and across the 31-day chunks", async () => {
    const { client, requests } = splitClient(longerThan(8));
    const r = await walkRange(client, "utilization", {}, "2026-08-01", "2026-09-14", { pageSize: 5000, maxRows: Infinity });
    const passed = requests.filter((q) => inclusiveDays(q.start, q.end) <= 8).map((q) => [q.start, q.end]);
    expect(passed).toEqual([
      ["2026-08-01", "2026-08-08"],
      ["2026-08-09", "2026-08-16"],
      ["2026-08-17", "2026-08-24"],
      ["2026-08-25", "2026-08-31"],
      ["2026-09-01", "2026-09-07"],
      ["2026-09-08", "2026-09-14"],
    ]);
    expect(r.rows.map(keyOf)).toEqual(rowsFor("2026-08-01", "2026-09-14").map(keyOf));
    expect(r).toMatchObject({ matched: 90, totalRecords: 90, chunks: 6, chunksPlanned: 6, splitAfterError: 4, duplicates: 0 });
    expect(rangeNotes(r, 31)).toEqual([
      "range split into 2 requests of up to 31 days",
      "Netic returned a server error for 4 window(s); each was split into shorter windows and retried",
    ]);
  });

  it("throws the original error naming the day when a single day still fails, and probes no further", async () => {
    const { client, requests } = splitClient((w) => (w.start <= "2026-09-15" && w.end >= "2026-09-15" ? 500 : undefined));
    const err = (await walkRange(client, "utilization", {}, "2026-09-10", "2026-09-23", { pageSize: 5000, maxRows: Infinity }).catch((e: unknown) => e)) as NeticApiError;
    expect(err).toBeInstanceOf(NeticApiError);
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/Failed to fetch utilization/);
    expect(err.message).toMatch(/single day 2026-09-15, after 4 longer window\(s\) failed and were split; it cannot be split further/);
    expect(requests.at(-1)).toMatchObject({ start: "2026-09-15", end: "2026-09-15" });
    expect(requests.some((q) => q.start > "2026-09-15")).toBe(false);
  });

  it("never streams a row twice when a window fails after its first page", async () => {
    const { client } = splitClient((w) => (inclusiveDays(w.start, w.end) > 7 && w.page >= 2 ? 500 : undefined));
    const streamed: Row[] = [];
    const r = await walkRange(client, "utilization", {}, "2026-09-10", "2026-09-23", {
      pageSize: 5,
      maxRows: Infinity,
      onRows: (rows) => {
        streamed.push(...rows);
      },
    });
    expect(streamed.map(keyOf)).toEqual(rowsFor("2026-09-10", "2026-09-23").map(keyOf));
    expect(new Set(streamed.map(keyOf)).size).toBe(28);
    expect(r.rows).toEqual([]);
    expect(r).toMatchObject({ matched: 28, scanned: 28, totalRecords: 28, pages: 6, splitAfterError: 1, repeatsDropped: 5, duplicates: 0 });
    expect(rangeNotes(r, 31)).toEqual([
      "Netic returned a server error for 1 window(s); each was split into shorter windows and retried; 5 row(s) returned before an error were not repeated",
    ]);
  });

  it("keeps rows from a failed window's earlier pages, once, without onRows", async () => {
    const { client } = splitClient((w) => (inclusiveDays(w.start, w.end) > 7 && w.page >= 2 ? 500 : undefined));
    const r = await walkRange(client, "utilization", {}, "2026-09-10", "2026-09-23", { pageSize: 5, maxRows: Infinity });
    expect(r.rows.map(keyOf)).toEqual(rowsFor("2026-09-10", "2026-09-23").map(keyOf));
    expect(r.matched).toBe(28);
  });

  it("stops at maxRows partway through the split windows", async () => {
    const { client, requests } = splitClient(longerThan(7));
    const r = await walkRange(client, "utilization", {}, "2026-09-10", "2026-09-23", { pageSize: 5000, maxRows: 16 });
    expect(r.rows.map(keyOf)).toEqual(rowsFor("2026-09-10", "2026-09-17").map(keyOf));
    expect(r).toMatchObject({ matched: 16, hasMore: true, chunks: 2, chunksPlanned: 2 });
    expect(requests).toHaveLength(3);

    const early = splitClient(longerThan(7));
    const e = await walkRange(early.client, "utilization", {}, "2026-09-10", "2026-09-23", { pageSize: 5000, maxRows: 14 });
    expect(early.requests).toHaveLength(2);
    expect(e).toMatchObject({ matched: 14, hasMore: true, chunks: 1, chunksPlanned: 2, totalRecords: 14 });
    expect(rangeNotes(e, 31)[0]).toMatch(/stopped after 1, so totalRecords covers only those/);
  });

  it("splits a 502 after the client's retries, but not a 503", async () => {
    const bad = splitClient(longerThan(7, 502));
    const r = await walkRange(bad.client, "utilization", {}, "2026-09-10", "2026-09-23", { pageSize: 5000, maxRows: Infinity });
    expect(bad.requests).toHaveLength(5);
    expect(r).toMatchObject({ matched: 28, splitAfterError: 1 });

    const down = splitClient(longerThan(7, 503));
    await expect(walkRange(down.client, "utilization", {}, "2026-09-10", "2026-09-23", { pageSize: 5000, maxRows: Infinity })).rejects.toThrow(/503/);
    expect(down.requests).toHaveLength(3);
  });

  it.each([400, 401])("does not split a %s", async (status) => {
    const { client, requests } = splitClient(() => status);
    await expect(walkRange(client, "utilization", {}, "2026-09-10", "2026-09-23", { pageSize: 5000, maxRows: Infinity })).rejects.toThrow(new RegExp(`Netic API ${status}`));
    expect(requests).toHaveLength(1);
  });

  it("does not split a report without a per-request range limit", async () => {
    const requests: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const client = new NeticClient({ tenant: "stl", token: "t", baseUrl: "https://example.test", timeoutMs: 1000, fetchImpl, sleep: async () => {} });
    await expect(
      walkRange(client, "interactions", { modality: "call", createdOnOrAfter: "2026-09-10", createdBefore: "2026-09-23" }, "2026-09-10", "2026-09-23", {
        pageSize: 5000,
        maxRows: Infinity,
      }),
    ).rejects.toThrow(/500/);
    expect(requests).toHaveLength(1);
  });
});
