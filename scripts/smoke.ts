/**
 * Live smoke test: every tool against the real Netic API through the built
 * server. Reads tenants from .env and writes exports to ./smoke-output.
 * Inline calls ask only for non-PII columns so the console stays clean.
 *
 *   npm run smoke            first tenant in .env
 *   npm run smoke -- blue    a specific tenant
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { addDays } from "../src/dates.js";
import { localDate, neticEnv, root } from "./env.js";

const env = neticEnv();
const tenants = [...loadConfig(env).tenants.keys()];
const tenant = process.argv[2]?.toLowerCase() ?? tenants[0];
if (!tenant || !tenants.includes(tenant)) {
  console.error(tenants.length === 0 ? "No tenants in .env. See .env.example." : `Pick one of: ${tenants.join(", ")}`);
  process.exit(2);
}
const bundle = path.join(root, "server", "index.cjs");
if (!fs.existsSync(bundle)) {
  console.error("Build first: npm run build");
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bundle],
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env, NETIC_OUTPUT_DIR: path.join(root, "smoke-output") },
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
}

let failures = 0;
/** `quiet` prints only the first line and the footer, for responses that carry raw rows. */
async function call(name: string, args: Record<string, unknown>, expectError = false, quiet = false): Promise<Record<string, unknown>> {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const ms = Date.now() - started;
  const full = text(result);
  const body = quiet ? [full.split("\n")[0], full.slice(full.lastIndexOf("---"))].join("\n(rows omitted)\n") : full;
  const bad = Boolean(result.isError) !== expectError;
  if (bad) failures += 1;
  console.log(`\n=== ${name} ${JSON.stringify(args)} (${ms} ms)${result.isError ? " ERROR" : ""}${bad ? " UNEXPECTED" : ""}`);
  console.log(body.length > 2000 ? `${body.slice(0, 2000)}\n... (${body.length} chars)` : body);
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

const end = localDate(-1);
const start = addDays(end, -6);
const range = { tenant, start, end };

try {
  await call("netic_list_tenants", {});
  await call("netic_get_interactions", { ...range, modality: "call", max_rows: 5, fields: ["date", "category", "reason", "trade", "leadSource"] });
  await call("netic_get_scheduler_sessions", { ...range, max_rows: 5, fields: ["status", "last_step", "booked_from", "marketing_source"] });
  await call("netic_get_scheduler_bookings", { ...range, max_rows: 5, fields: ["session_created_at", "session_status", "session_source", "utm_source"] });
  await call("netic_get_tgl_bookings", { ...range, max_rows: 5, fields: ["booked_at", "date", "job_type_name", "service_type", "outcome_type"] });
  await call("netic_get_referrer_bookings", { ...range, max_rows: 5, fields: ["booked_at", "job_type", "status"] });
  await call("netic_get_outbound_calls", { ...range, max_rows: 5, fields: ["call_placed_at", "call_type", "call_reason", "call_duration_seconds"] });
  await call("netic_get_utilization", { tenant, start: end, end, max_rows: 50 });
  await call("netic_get_utilization", { tenant, start: end, end, snapshot_date: start, snapshot_time: "08:00", type: "group" });
  await call("netic_get_utilization", { tenant, start: addDays(end, -44), end, type: "group", max_rows: 5 });
  await call("netic_count", { ...range, report: "utilization", aggregate: "sum", group_by: ["type", "name"], top: 20 });
  await call("netic_count", { ...range, report: "utilization", aggregate: "sum", group_by: ["date"], where: { type: "business_unit" } });
  await call("netic_get_utilization", { tenant, start: end, end, snapshot_time: "08:00" }, true);
  await call("netic_count", { ...range, report: "interactions", aggregate: "sum", modality: "call", group_by: ["category"] }, true);
  await call("netic_count", { ...range, report: "interactions", modality: "call", group_by: ["category", "leadSource"], top: 15 });
  await call("netic_count", { ...range, report: "scheduler_sessions", group_by: ["status", "last_step"] });
  await call("netic_export", { ...range, report: "interactions", modality: "call", filename: `smoke_${tenant}_interactions` });
  await call("netic_export", { ...range, report: "outbound_calls", format: "json", filename: `smoke_${tenant}_outbound` });
  await call("netic_api_call", { tenant, path: "/api/public/metrics/bookings/referrer", params: { createdOnOrAfter: start, createdBefore: end, pageSize: 1 }, max_items: 1 }, false, true);
  await call("netic_api_call", { tenant, path: "/api/public/metrics/web/leads" }, true);
  await call("netic_get_referrer_bookings", { tenant: "not-a-tenant", start, end }, true);
} finally {
  await client.close();
}
console.log(failures === 0 ? "\nSMOKE OK" : `\nSMOKE FAILED: ${failures} unexpected result(s)`);
process.exit(failures === 0 ? 0 : 1);
