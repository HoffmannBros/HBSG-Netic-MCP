import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Drives the built server's tools end to end against a local fake of the
 * Netic API, so paging, footers, counts, and exports are covered without a
 * real token.
 */
const root = path.resolve(__dirname, "..");
const bundle = path.join(root, "server", "index.cjs");

interface Seen {
  method: string;
  url: URL;
  auth: string | undefined;
}

const seen: Seen[] = [];

/** Utilization rows for every day in startDate..endDate: one group and its two units. */
function utilizationRows(url: URL): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const end = url.searchParams.get("endDate") ?? "";
  for (let d = url.searchParams.get("startDate") ?? ""; d && d <= end; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
    out.push(
      { date: d, type: "group", name: "HVAC Service", businessUnitId: null, groups: [], percentBooked: 99, jobHours: 87.8, shiftHours: 102, nonJobHours: 13.1, availableHours: 88.9, jobs: 37 },
      { date: d, type: "business_unit", name: "HVAC Maintenance", businessUnitId: 2, groups: ["HVAC Service"], percentBooked: null, jobHours: 48.5, shiftHours: 0, nonJobHours: 0, availableHours: 0, jobs: 23 },
      { date: d, type: "business_unit", name: "HVAC Service", businessUnitId: 1, groups: ["HVAC Service"], percentBooked: 44, jobHours: 39.3, shiftHours: 102, nonJobHours: 13.1, availableHours: 88.9, jobs: 14 },
    );
  }
  return out;
}

/** Scheduler sessions: four leads in 2026-09-01..07, one earlier repeat, and two that are not leads. */
function sessionRows(): Array<Record<string, unknown>> {
  const base = { status: "abandoned", customer_name: "", customer_phone_number: "", street_address: "", zip_code: "", job_type: "", utm_source: "", booked_job_id: "" };
  return [
    { ...base, id: "sA", session_created_at: "2026-09-01 08:00:00", last_step: "schedule", customer_name: "A", customer_phone_number: "555-555-0100", job_type: "AC Repair", utm_source: "google" },
    { ...base, id: "sB", session_created_at: "2026-09-02 10:00:00", last_step: "customer", customer_name: "B", customer_phone_number: "3145550111", job_type: "Drain" },
    { ...base, id: "sC", session_created_at: "2026-09-03 11:00:00", status: "completed", last_step: "booked", customer_name: "B", customer_phone_number: "(314) 555-0111", job_type: "Drain", booked_job_id: "J1" },
    { ...base, id: "sD", session_created_at: "2026-09-04 12:00:00", last_step: "confirmation", customer_name: "D", street_address: "1 Main St", zip_code: "63101", job_type: "AC Repair" },
    { ...base, id: "sE", session_created_at: "2026-09-05 12:00:00", last_step: "issue" },
    { ...base, id: "sF", session_created_at: "2026-08-20 09:00:00", last_step: "details", customer_name: "B", customer_phone_number: "3145550111" },
    { ...base, id: "sG", session_created_at: "2026-09-06 09:00:00", status: "completed", last_step: "booked", customer_name: "G" },
  ];
}

function rowsFor(pathname: string): Array<Record<string, unknown>> {
  if (pathname.endsWith("/scheduler/sessions")) return sessionRows();
  if (pathname.endsWith("/interactions")) {
    return Array.from({ length: 1234 }, (_, i) => ({
      id: `i${i}`,
      tenant: "Hoffmann STL",
      date: "09/01/2026 09:42",
      category: i % 4 === 0 ? "Booked" : "Not Booked",
      leadSource: i % 2 === 0 ? "google-lsa" : null,
      phoneNumber: "+15555550100",
      trade: "HVAC",
      reason: "r",
    }));
  }
  if (pathname.endsWith("/calls/outbound")) {
    return [{ id: "c1", call_placed_at: "2026-09-01T09:00:00-05:00", agent_name: "A", summary: "s", transcript: "very long transcript", analysis: "" }];
  }
  return [{ id: "r1", booked_at: "2026-09-01", referrer_email: "x@example.test", status: "Booked" }];
}

let server: http.Server;
let client: Client;
let outDir: string;

beforeAll(async () => {
  if (!fs.existsSync(bundle)) throw new Error(`Build first: ${bundle} is missing (npm run build).`);
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    seen.push({ method: req.method ?? "", url, auth: req.headers.authorization });
    const utilization = url.pathname.endsWith("/utilization");
    const all = utilization ? utilizationRows(url) : rowsFor(url.pathname);
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 100);
    const data = all.slice((page - 1) * pageSize, page * pageSize);
    const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
    res.setHeader("content-type", "application/json");
    const extras = utilization
      ? { timeZone: "America/Denver", snapshotAt: url.searchParams.get("snapshotDate") ? `${url.searchParams.get("snapshotDate")}T23:59:59.999-06:00` : null }
      : {};
    res.end(JSON.stringify({ data, pagination: { page, pageSize, totalRecords: all.length, totalPages, hasMore: page < totalPages }, ...extras }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "netic-tools-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundle],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NETIC_BASE_URL: `http://127.0.0.1:${port}`,
      NETIC_TENANTS: "stl",
      NETIC_TENANT_STL_TOKEN: "fake-stl-token",
      NETIC_OUTPUT_DIR: outDir,
    },
    cwd: root,
    stderr: "pipe",
  });
  client = new Client({ name: "tools-test", version: "0.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (outDir) await fsp.rm(outDir, { recursive: true, force: true });
});

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (r: ToolResult) => (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
const range = { start: "2026-09-01", end: "2026-09-07" };

describe("tools against a fake Netic API", () => {
  it("auto-pages interactions up to max_rows and says hasMore in the footer", async () => {
    seen.length = 0;
    const result = await client.callTool({ name: "netic_get_interactions", arguments: { tenant: "STL", modality: "call", max_rows: 150, ...range } });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("150 of 1234 row(s)");
    expect(text).toContain("hasMore: true");
    expect(text).toMatch(/\| date \| phoneNumber \|/);
    expect(seen.every((s) => s.method === "GET")).toBe(true);
    expect(seen[0]?.auth).toBe("Bearer fake-stl-token");
    expect(seen[0]?.url.searchParams.get("createdOnOrAfter")).toBe("2026-09-01");
    expect(seen[0]?.url.searchParams.get("createdBefore")).toBe("2026-09-07");
    expect(seen[0]?.url.searchParams.get("modality")).toBe("call");
    expect(text).not.toContain("fake-stl-token");
  });

  it("counts every row across pages, grouped by two fields", async () => {
    const result = await client.callTool({
      name: "netic_count",
      arguments: { tenant: "stl", report: "interactions", modality: "call", group_by: ["category", "leadSource"], ...range },
    });
    const text = textOf(result);
    expect(result.isError).toBeFalsy();
    expect(text).toMatch(/^1234 inbound interactions/);
    expect(text).toContain("| Not Booked | (blank) | 617 |");
    expect(text).toContain("hasMore: false");
    const s = result.structuredContent as { total: number; groupCount: number };
    expect(s.total).toBe(1234);
    expect(s.groupCount).toBe(3);
  });

  it("applies where filters in counts", async () => {
    const result = await client.callTool({
      name: "netic_count",
      arguments: { tenant: "stl", report: "interactions", modality: "call", group_by: ["leadSource"], where: { category: "booked" }, ...range },
    });
    expect((result.structuredContent as { total: number }).total).toBe(309);
    expect(textOf(result)).toContain("309 matching row(s) from 1234 scanned");
  });

  it("exports every row to CSV", async () => {
    const result = await client.callTool({
      name: "netic_export",
      arguments: { tenant: "stl", report: "interactions", modality: "call", filename: "all", ...range },
    });
    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as { path: string; rows: number };
    expect(s.rows).toBe(1234);
    expect(path.dirname(s.path)).toBe(outDir);
    const csv = await fsp.readFile(s.path, "utf8");
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(1235);
  });

  it("forces JSON on outbound calls and omits transcripts inline", async () => {
    seen.length = 0;
    const result = await client.callTool({ name: "netic_get_outbound_calls", arguments: { tenant: "stl", agent_ids: ["12", 34], ...range } });
    const text = textOf(result);
    expect(seen[0]?.url.searchParams.get("format")).toBe("json");
    expect(seen[0]?.url.searchParams.get("agentId")).toBe("12,34");
    expect(text).not.toContain("very long transcript");
    expect(text).toMatch(/Transcripts omitted/);
  });

  it("keeps transcripts in exports by default", async () => {
    const result = await client.callTool({ name: "netic_export", arguments: { tenant: "stl", report: "outbound_calls", format: "json", ...range } });
    const s = result.structuredContent as { path: string };
    const rows = JSON.parse(await fsp.readFile(s.path, "utf8")) as Array<{ transcript?: string }>;
    expect(rows[0]?.transcript).toBe("very long transcript");
  });

  it("passes a raw GET through and shows the pagination footer", async () => {
    const result = await client.callTool({
      name: "netic_api_call",
      arguments: { tenant: "stl", path: "/api/public/metrics/bookings/referrer", params: { createdOnOrAfter: "2026-09-01", createdBefore: "2026-09-01" } },
    });
    const text = textOf(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain("x@example.test");
    expect(text).toContain("totalRecords 1");
  });

  it("puts inline rows in structuredContent, which is all Claude's client shows the model", async () => {
    const result = await client.callTool({ name: "netic_get_interactions", arguments: { tenant: "stl", modality: "call", max_rows: 3, ...range } });
    const s = result.structuredContent as { rows: Array<Record<string, unknown>>; columns: string[]; returned: number };
    expect(s.returned).toBe(3);
    expect(s.rows).toHaveLength(3);
    expect(Object.keys(s.rows[0] ?? {})).toEqual(s.columns);
    expect(s.rows[0]?.category).toBe("Booked");

    const raw = await client.callTool({
      name: "netic_api_call",
      arguments: { tenant: "stl", path: "/api/public/metrics/bookings/referrer", params: { createdOnOrAfter: "2026-09-01", createdBefore: "2026-09-01" } },
    });
    expect((raw.structuredContent as { rows: Array<Record<string, unknown>> }).rows[0]?.referrer_email).toBe("x@example.test");
  });

  it("sends startDate and endDate for utilization and shows the board cell", async () => {
    seen.length = 0;
    const result = await client.callTool({ name: "netic_get_utilization", arguments: { tenant: "stl", start: "2026-09-24", end: "2026-09-24" } });
    expect(result.isError).toBeFalsy();
    const url = seen[0]?.url;
    expect(url?.searchParams.get("startDate")).toBe("2026-09-24");
    expect(url?.searchParams.get("endDate")).toBe("2026-09-24");
    expect(url?.searchParams.has("createdOnOrAfter")).toBe(false);
    const text = textOf(result);
    expect(text).toContain("37 jobs · 99%");
    expect(text).toContain("23 jobs · No shifts");
    expect(text).toContain("timeZone America/Denver");
    expect(text).toContain("Live board");
    const s = result.structuredContent as { rows: Array<Record<string, unknown>>; timeZone: string };
    expect(s.timeZone).toBe("America/Denver");
    expect(s.rows).toHaveLength(3);
    expect(s.rows[1]).toMatchObject({ name: "HVAC Maintenance", board: "23 jobs · No shifts", percentBooked: null });
  });

  it("splits a 45-day utilization range into 31-day requests with no gaps or overlaps", async () => {
    seen.length = 0;
    const result = await client.callTool({
      name: "netic_get_utilization",
      arguments: { tenant: "stl", start: "2026-08-01", end: "2026-09-14", type: "group", max_rows: 5000 },
    });
    expect(result.isError).toBeFalsy();
    const windows = seen.map((s) => [s.url.searchParams.get("startDate"), s.url.searchParams.get("endDate")]);
    expect(windows).toEqual([
      ["2026-08-01", "2026-08-31"],
      ["2026-09-01", "2026-09-14"],
    ]);
    const s = result.structuredContent as { rows: Array<{ date: string }>; totalRecords: number };
    expect(s.rows).toHaveLength(45);
    expect(new Set(s.rows.map((r) => r.date)).size).toBe(45);
    expect(s.totalRecords).toBe(135);
    expect(textOf(result)).toContain("range split into 2 requests");
  });

  it("filters utilization by name, ignoring case and stray spaces", async () => {
    const result = await client.callTool({ name: "netic_get_utilization", arguments: { tenant: "stl", start: "2026-09-24", end: "2026-09-24", name: " hvac maintenance " } });
    expect((result.structuredContent as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it("passes a snapshot through and says so in the footer", async () => {
    seen.length = 0;
    const result = await client.callTool({
      name: "netic_get_utilization",
      arguments: { tenant: "stl", start: "2026-09-24", end: "2026-09-24", snapshot_date: "2026-09-23", snapshot_time: "08:00" },
    });
    expect(seen[0]?.url.searchParams.get("snapshotDate")).toBe("2026-09-23");
    expect(seen[0]?.url.searchParams.get("snapshotTime")).toBe("08:00");
    expect(textOf(result)).toContain("Point in time: board as it stood at 2026-09-23T23:59:59.999-06:00");
  });

  it("refuses snapshot_time without snapshot_date before calling the API", async () => {
    seen.length = 0;
    const result = await client.callTool({ name: "netic_get_utilization", arguments: { tenant: "stl", start: "2026-09-24", end: "2026-09-24", snapshot_time: "08:00" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/snapshotTime needs snapshotDate/);
    expect(seen).toHaveLength(0);
  });

  it("sums utilization per group and recomputes % booked from the sums", async () => {
    const result = await client.callTool({
      name: "netic_count",
      arguments: { tenant: "stl", report: "utilization", aggregate: "sum", group_by: ["type", "name"], start: "2026-09-20", end: "2026-09-26" },
    });
    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as { groups: Array<{ values: string[]; rows: number; jobHours: number; availableHours: number; percentBooked: number | null }> };
    const group = s.groups.find((g) => g.values[0] === "group");
    expect(group).toMatchObject({ rows: 7, jobHours: 614.6, availableHours: 622.3, percentBooked: 99 });
    expect(s.groups.find((g) => g.values[1] === "HVAC Maintenance")?.percentBooked).toBeNull();
    expect(textOf(result)).not.toContain("Warning");
  });

  it("warns when a sum mixes group rows with their member units", async () => {
    const result = await client.callTool({
      name: "netic_count",
      arguments: { tenant: "stl", report: "utilization", aggregate: "sum", group_by: ["date"], start: "2026-09-24", end: "2026-09-24" },
    });
    expect(textOf(result)).toMatch(/Warning: these totals mix group rows with business_unit rows/);
    expect((result.structuredContent as { mixesTypes: boolean }).mixesTypes).toBe(true);
  });

  it("builds scheduler leads with follow-up flags and a summary", async () => {
    seen.length = 0;
    const result = await client.callTool({ name: "netic_get_scheduler_leads", arguments: { tenant: "stl", ...range } });
    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as {
      summary: { leads: number; booked: number; abandoned: number; recovered: number; stillBounced: number };
      rows: Array<Record<string, unknown>>;
      fetchStart: string;
    };
    expect(s.summary).toMatchObject({ leads: 4, booked: 1, abandoned: 3, recovered: 2, stillBounced: 1 });
    expect(s.fetchStart).toBe("2026-08-25");
    const byName = (n: string, booked: string) => s.rows.find((r) => r.Name === n && r.Booked === booked);
    expect(byName("A", "No")).toMatchObject({ contacted_later: "Yes", contacted_later_category: "Booked", recovered: "Yes", "Furthest Stage Reached": "Schedule (stage 4 of 6)" });
    expect(byName("B", "No")).toMatchObject({ booked_later: "Yes", attempt: 2, recovered: "Yes" });
    expect(byName("D", "No")).toMatchObject({ contacted_later: "No", recovered: "No" });
    const paths = new Set(seen.map((x) => x.url.pathname));
    expect(paths).toEqual(new Set(["/api/public/metrics/scheduler/sessions", "/api/public/metrics/interactions"]));
    expect(new Set(seen.filter((x) => x.url.pathname.endsWith("/interactions")).map((x) => x.url.searchParams.get("modality")))).toEqual(
      new Set(["call", "inbound_text", "recapture_text"]),
    );
    expect(seen.find((x) => x.url.pathname.endsWith("/sessions"))?.url.searchParams.get("createdOnOrAfter")).toBe("2026-08-25");
    expect(textOf(result)).toContain("4 lead(s)");
    expect((result.structuredContent as { followUp: Record<string, unknown> }).followUp).toMatchObject({ contactsChecked: true, windowDays: 7, windowStillOpen: false });
  });

  it("leaves only the still-bounced leads for a digest, and skips contacts when asked", async () => {
    seen.length = 0;
    const result = await client.callTool({
      name: "netic_get_scheduler_leads",
      arguments: { tenant: "stl", booked: "no", exclude_recovered: true, check_contacts: false, ...range },
    });
    const s = result.structuredContent as { rows: Array<Record<string, unknown>> };
    expect(s.rows.map((r) => r.Name)).toEqual(["A", "D"]);
    expect(seen.every((x) => x.url.pathname.endsWith("/scheduler/sessions"))).toBe(true);
    expect(textOf(result)).toContain("contact check skipped");
    const f = (result.structuredContent as { followUp: { contactsChecked: boolean; interactionsChecked: number | null; caveat: string } }).followUp;
    expect(f).toMatchObject({ contactsChecked: false, interactionsChecked: null });
    expect(f.caveat).toMatch(/contacts were not checked/);
  });

  it("counts scheduler leads by an export column", async () => {
    const result = await client.callTool({ name: "netic_count", arguments: { tenant: "stl", report: "scheduler_leads", group_by: ["Service"], where: { Booked: "No" }, ...range } });
    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as { total: number; groups: Array<{ values: string[]; count: number }> };
    expect(s.total).toBe(3);
    expect(s.groups[0]).toEqual({ values: ["AC Repair"], count: 2 });
    expect(textOf(result)).toMatch(/^3 online scheduler leads/);
    expect((result.structuredContent as { followUp?: { contactsChecked: boolean } }).followUp?.contactsChecked).toBe(true);
  });

  it("exports scheduler leads with the export's header order", async () => {
    const result = await client.callTool({ name: "netic_export", arguments: { tenant: "stl", report: "scheduler_leads", check_contacts: false, ...range } });
    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as { path: string; rows: number };
    expect(s.rows).toBe(4);
    expect(path.basename(s.path)).toBe("netic_stl_scheduler_leads_2026-09-01_2026-09-07.csv");
    const header = (await fsp.readFile(s.path, "utf8")).replace(/^﻿/, "").split(/\r?\n/)[0];
    expect(header?.startsWith("Tenant,Date,Name,Identified By,Phone Number,Street Address,City,State,Zip Code,Booked,Furthest Stage Reached,Service,UTM Source,UTM Medium,UTM Campaign,")).toBe(true);
  });

  it("refuses aggregate=sum on reports other than utilization", async () => {
    const result = await client.callTool({
      name: "netic_count",
      arguments: { tenant: "stl", report: "interactions", modality: "call", aggregate: "sum", group_by: ["category"], ...range },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/applies only to report=utilization/);
  });
});
