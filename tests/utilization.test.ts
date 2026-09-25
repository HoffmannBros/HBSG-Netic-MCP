import { describe, expect, it } from "vitest";
import { GroupSummer } from "../src/aggregate.js";
import { NeticClient, NeticRequestError, type Row } from "../src/client.js";
import { DateError, addDays, latestDateAnywhere, splitRange } from "../src/dates.js";
import { UTILIZATION_PATH } from "../src/endpoints.js";
import { singleRangePage, walkRange } from "../src/paging.js";
import { boardCell, namePredicate, percentBooked } from "../src/utilization.js";

describe("splitRange", () => {
  it("splits 45 days into 31 + 14, contiguous and non-overlapping", () => {
    expect(splitRange("2026-08-01", "2026-09-14", 31)).toEqual([
      { start: "2026-08-01", end: "2026-08-31" },
      { start: "2026-09-01", end: "2026-09-14" },
    ]);
  });

  it("keeps a range at the limit whole, and one day as one chunk", () => {
    expect(splitRange("2026-08-25", "2026-09-24", 31)).toEqual([{ start: "2026-08-25", end: "2026-09-24" }]);
    expect(splitRange("2026-09-24", "2026-09-24", 31)).toEqual([{ start: "2026-09-24", end: "2026-09-24" }]);
  });

  it("covers every day exactly once over a long range", () => {
    const chunks = splitRange("2026-01-01", "2026-12-31", 31);
    expect(chunks).toHaveLength(12);
    for (let i = 1; i < chunks.length; i += 1) expect(chunks[i]?.start).toBe(addDays(chunks[i - 1]!.end, 1));
    expect(chunks.at(-1)?.end).toBe("2026-12-31");
  });
});

describe("percentBooked and the board cell", () => {
  it("matches the board: job hours over available hours, rounded", () => {
    expect(percentBooked(87.8, 102, 88.9)).toBe(99);
    expect(percentBooked(49, 25.5, 22.5)).toBe(218); // Netic says 217 from unrounded hours
  });

  it("is null with no shifts and 0 when shifts leave no available time", () => {
    expect(percentBooked(48.5, 0, 0)).toBeNull();
    expect(percentBooked(2.5, 16, 0)).toBe(0);
  });

  it("renders cells the way the board does", () => {
    expect(boardCell({ jobs: 37, percentBooked: 99 })).toBe("37 jobs · 99%");
    expect(boardCell({ jobs: 1, percentBooked: 5 })).toBe("1 job · 5%");
    expect(boardCell({ jobs: 23, percentBooked: null })).toBe("23 jobs · No shifts");
    expect(boardCell({ jobs: 0, percentBooked: 0 })).toBe("0 jobs · 0%");
  });

  it("matches names case-insensitively and ignores stray spaces", () => {
    const match = namePredicate(["hvac sales", "Drains"])!;
    expect(match({ name: "HVAC Sales " })).toBe(true);
    expect(match({ name: "Drains" })).toBe(true);
    expect(match({ name: "HVAC Service" })).toBe(false);
    expect(namePredicate(undefined)).toBeUndefined();
  });
});

describe("GroupSummer", () => {
  const group = { type: "group", name: "HVAC Service", jobs: 37, jobHours: 87.8, shiftHours: 102, nonJobHours: 13.1, availableHours: 88.9, percentBooked: 99 };
  const maintenance = { type: "business_unit", name: "HVAC Maintenance", jobs: 23, jobHours: 48.5, shiftHours: 0, nonJobHours: 0, availableHours: 0, percentBooked: null };
  const service = { type: "business_unit", name: "HVAC Service", jobs: 14, jobHours: 39.3, shiftHours: 102, nonJobHours: 13.1, availableHours: 88.9, percentBooked: 44 };

  it("sums the two HVAC units into the group's 87.8 / 88.9 = 99%", () => {
    const s = new GroupSummer(["date"]);
    s.addMany([
      { ...maintenance, date: "2026-09-24" },
      { ...service, date: "2026-09-24" },
    ]);
    expect(s.groups()).toEqual([
      { values: ["2026-09-24"], rows: 2, sums: { jobs: 37, jobHours: 87.8, shiftHours: 102, nonJobHours: 13.1, availableHours: 88.9 }, percentBooked: 99 },
    ]);
    expect(s.mixesTypes()).toBe(false);
  });

  it("keeps the API's own percentBooked for a single row, including null", () => {
    const s = new GroupSummer(["name"]);
    s.addMany([{ ...group, percentBooked: 217 }, maintenance]);
    const byName = Object.fromEntries(s.groups().map((g) => [g.values[0], g.percentBooked]));
    expect(byName).toEqual({ "HVAC Service": 217, "HVAC Maintenance": null });
  });

  it("recomputes across days instead of averaging, and returns null with no shifts", () => {
    const s = new GroupSummer(["name"]);
    s.addMany([
      { ...service, jobHours: 10, availableHours: 10, shiftHours: 10 },
      { ...service, jobHours: 30, availableHours: 90, shiftHours: 90 },
      maintenance,
      maintenance,
    ]);
    const [first, second] = s.groups();
    expect(first).toMatchObject({ values: ["HVAC Maintenance"], percentBooked: null });
    expect(second).toMatchObject({ values: ["HVAC Service"], rows: 2, percentBooked: 40 }); // 40/100, not avg(100, 33)
  });

  it("flags a sum that mixes group and business_unit rows", () => {
    const s = new GroupSummer(["name"]);
    s.addMany([group, service]);
    expect(s.mixesTypes()).toBe(true);
  });
});

function utilClient(handler: (url: URL) => Row[]) {
  const requests: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url);
    const data = handler(url);
    return new Response(
      JSON.stringify({ data, pagination: { page: 1, pageSize: 5000, totalRecords: data.length, totalPages: 1, hasMore: false }, timeZone: "America/Denver", snapshotAt: null }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const client = new NeticClient({ tenant: "blue", token: "t", baseUrl: "https://example.test", timeoutMs: 1000, fetchImpl, sleep: async () => {} });
  return { client, requests };
}

describe("walkRange on utilization", () => {
  it("chunks, keeps the envelope extras, and drops a row repeated at a boundary", async () => {
    const { client, requests } = utilClient((url) => [{ date: url.searchParams.get("startDate"), type: "group", name: "G", businessUnitId: null }]);
    const r = await walkRange(client, "utilization", {}, "2026-08-01", "2026-09-14", { pageSize: 5000, maxRows: Infinity });
    expect(requests.map((u) => [u.searchParams.get("startDate"), u.searchParams.get("endDate")])).toEqual([
      ["2026-08-01", "2026-08-31"],
      ["2026-09-01", "2026-09-14"],
    ]);
    expect(r.chunks).toBe(2);
    expect(r.rows.map((x) => x.date)).toEqual(["2026-08-01", "2026-09-01"]);
    expect(r.duplicates).toBe(0);
    expect(r.extras).toEqual({ timeZone: "America/Denver", snapshotAt: null });

    // A row repeated by two chunks, as a boundary bug would do, is kept once.
    const dup = utilClient(() => [{ date: "2026-08-31", type: "group", name: "G", businessUnitId: null }]);
    const d = await walkRange(dup.client, "utilization", {}, "2026-08-01", "2026-09-14", { pageSize: 5000, maxRows: Infinity });
    expect(d.rows).toHaveLength(1);
    expect(d.duplicates).toBe(1);
  });

  it("shares max_rows across chunks and reports hasMore", async () => {
    const { client, requests } = utilClient((url) => [{ date: url.searchParams.get("startDate"), type: "group", name: "G", businessUnitId: null }]);
    const r = await walkRange(client, "utilization", {}, "2026-01-01", "2026-12-31", { pageSize: 5000, maxRows: 2 });
    expect(r.rows).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(r.hasMore).toBe(true);
  });

  it("refuses a hand-picked page on a range that needs splitting", async () => {
    const { client } = utilClient(() => []);
    await expect(singleRangePage(client, "utilization", {}, "2026-08-01", "2026-09-14", 1, 100)).rejects.toThrow(NeticRequestError);
  });
});

describe("utilization preflight", () => {
  const { client } = utilClient(() => []);
  const day = { startDate: "2026-09-24", endDate: "2026-09-24" };

  it("uses startDate and endDate, not createdOnOrAfter", () => {
    expect(() => client.preflight(UTILIZATION_PATH, day)).not.toThrow();
    expect(() => client.preflight(UTILIZATION_PATH, { createdOnOrAfter: "2026-09-24", createdBefore: "2026-09-24" })).toThrow(/startDate \(start\) is required/);
  });

  it("allows 31 inclusive days and refuses 32", () => {
    expect(() => client.preflight(UTILIZATION_PATH, { startDate: "2026-08-25", endDate: "2026-09-24" })).not.toThrow();
    expect(() => client.preflight(UTILIZATION_PATH, { startDate: "2026-08-24", endDate: "2026-09-24" })).toThrow(/at most 31 days/);
  });

  it("refuses snapshotTime without snapshotDate, a malformed time, and a future date", () => {
    expect(() => client.preflight(UTILIZATION_PATH, { ...day, snapshotTime: "08:00" })).toThrow(DateError);
    expect(() => client.preflight(UTILIZATION_PATH, { ...day, snapshotDate: "2026-09-23", snapshotTime: "8am" })).toThrow(/HH:mm/);
    expect(() => client.preflight(UTILIZATION_PATH, { ...day, snapshotDate: addDays(latestDateAnywhere(), 1) })).toThrow(/future/);
    expect(() => client.preflight(UTILIZATION_PATH, { ...day, snapshotDate: "2026-09-23", snapshotTime: "08:00" })).not.toThrow();
  });
});
