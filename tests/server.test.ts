import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { DRAFT_07_ONLY_KEYWORDS, JSON_SCHEMA_DIALECT } from "../src/schema-compat.js";

const root = path.resolve(__dirname, "..");
const bundle = path.join(root, "server", "index.cjs");

const EXPECTED_TOOLS = [
  "netic_list_tenants",
  "netic_get_interactions",
  "netic_get_scheduler_sessions",
  "netic_get_scheduler_bookings",
  "netic_get_scheduler_leads",
  "netic_get_tgl_bookings",
  "netic_get_referrer_bookings",
  "netic_get_outbound_calls",
  "netic_get_utilization",
  "netic_count",
  "netic_export",
  "netic_api_call",
];

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (r: ToolResult) => (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");

async function connect(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundle],
    // An unroutable base URL: any request that slips past a guard fails fast
    // with a network error instead of reaching Netic.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NETIC_BASE_URL: "http://127.0.0.1:9", NETIC_TIMEOUT_MS: "2000", ...env },
    cwd: root,
    stderr: "pipe",
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

describe("built server over stdio", () => {
  let client: Client;
  let bare: Client;

  beforeAll(async () => {
    if (!fs.existsSync(bundle)) throw new Error(`Build first: ${bundle} is missing (npm run build).`);
    client = await connect({ NETIC_TENANTS: "stl,blue", NETIC_TENANT_STL_TOKEN: "fake-stl", NETIC_TENANT_BLUE_TOKEN: "fake-blue" });
    bare = await connect({});
  });

  afterAll(async () => {
    await client?.close();
    await bare?.close();
  });

  it("exposes exactly the twelve Netic tools, all read-only", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(40);
    }
  });

  it("requires tenant on every tool except netic_list_tenants", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      if (tool.name === "netic_list_tenants") continue;
      expect((tool.inputSchema as { required?: string[] }).required ?? [], tool.name).toContain("tenant");
    }
  });

  it("lists tenant names and never tokens", async () => {
    const result = await client.callTool({ name: "netic_list_tenants", arguments: {} });
    const text = textOf(result);
    expect(text).toContain("stl");
    expect(text).toContain("blue");
    expect(text).not.toContain("fake-");
  });

  it("refuses an unknown tenant and names the valid ones", async () => {
    const result = await client.callTool({
      name: "netic_get_referrer_bookings",
      arguments: { tenant: "ferg", start: "2026-09-01", end: "2026-09-07" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Configured tenants: stl, blue/);
  });

  it("returns a configuration error, not a crash, when no tenant is configured", async () => {
    const result = await bare.callTool({ name: "netic_count", arguments: { tenant: "stl", report: "referrer_bookings", start: "2026-09-01", end: "2026-09-07", group_by: ["status"] } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No Netic tenants are configured/);
  });

  it("validates dates before touching the network", async () => {
    const result = await client.callTool({
      name: "netic_get_scheduler_bookings",
      arguments: { tenant: "stl", start: "2026-09-08", end: "2026-09-01" },
    });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/before start date/);
    expect(text).not.toMatch(/Network error/);
  });

  it("requires modality for interactions in count and export", async () => {
    const result = await client.callTool({
      name: "netic_count",
      arguments: { tenant: "stl", report: "interactions", start: "2026-09-01", end: "2026-09-07", group_by: ["category"] },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/modality is required/);
  });

  it.each(["/api/public/metrics/web/leads", "/api/public/metrics/Web/Leads/", "/api/public/metrics/x/../web/leads"])(
    "refuses the web-leads path %s through the raw tool without sending a request",
    async (p) => {
      const result = await client.callTool({ name: "netic_api_call", arguments: { tenant: "stl", path: p } });
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toMatch(/Refused|not allowed/);
      expect(text).not.toMatch(/Network error/);
    },
  );

  it("declares a dialect Claude's Ajv 2020 client validator can compile", async () => {
    const { tools } = await client.listTools();
    const ajv = new Ajv2020({ strict: false });
    for (const tool of tools) {
      for (const [kind, schema] of [
        ["inputSchema", tool.inputSchema],
        ["outputSchema", tool.outputSchema],
      ] as const) {
        if (!schema) continue;
        expect((schema as { $schema?: string }).$schema, `${tool.name}.${kind}`).toBe(JSON_SCHEMA_DIALECT);
        expect(() => ajv.compile(schema as object), `${tool.name}.${kind}`).not.toThrow();
      }
    }
  });

  it("uses no draft-07-only keyword that the dialect restamp would silently change", async () => {
    const { tools } = await client.listTools();
    const offenders: string[] = [];
    const walk = (node: unknown, at: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, `${at}[${i}]`));
        return;
      }
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if ((DRAFT_07_ONLY_KEYWORDS as readonly string[]).includes(key)) offenders.push(`${at}.${key}`);
        walk(value, `${at}.${key}`);
      }
    };
    for (const tool of tools) {
      walk(tool.inputSchema, `${tool.name}.inputSchema`);
      walk(tool.outputSchema, `${tool.name}.outputSchema`);
    }
    expect(offenders).toEqual([]);
  });
});
