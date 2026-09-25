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

function rowsFor(pathname: string): Array<Record<string, unknown>> {
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
    const all = rowsFor(url.pathname);
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 100);
    const data = all.slice((page - 1) * pageSize, page * pageSize);
    const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data, pagination: { page, pageSize, totalRecords: all.length, totalPages, hasMore: page < totalPages } }));
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
});
