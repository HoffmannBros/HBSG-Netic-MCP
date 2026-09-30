import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContext } from "./context.js";
import { withSchemaCompat } from "./schema-compat.js";
import { registerAggregateTools } from "./tools/aggregate.js";
import { registerExportTools } from "./tools/export.js";
import { registerLeadTools } from "./tools/leads.js";
import { registerRawTools } from "./tools/raw.js";
import { registerReportTools } from "./tools/reports.js";
import { registerTenantTools } from "./tools/tenants.js";
import { SERVER_NAME, VERSION } from "./version.js";

const INSTRUCTIONS = `Netic is the AI voice agent, texting, and online booking platform used by Hoffmann Brothers' brands. This server reads its Reports Export API, the same rows as the Netic dashboard CSV exports.
Every tool needs tenant, one brand per tenant (stl Hoffmann STL, nash Hoffmann NSH, blue Blue Sky, ferg Ferguson STL). There is no default: if the user did not name a brand, ask, or call netic_list_tenants.
Dates are YYYY-MM-DD and both bounds are inclusive in the tenant's local time; one day is start = end.
For "how many" questions use netic_count, which walks every page and groups by up to three columns. For full pulls use netic_export. The netic_get_* tools return a sample capped by max_rows: read the footer (rows returned of totalRecords, hasMore) before stating totals from them.
netic_get_utilization is the Netic Utilization Board: % booked (job hours / available hours) per business unit and group per day. null means "No shifts", over 100% is overbooked, and a group row already includes its member units. Live by default; snapshot_date is the board's Point in time. For % booked over several days use netic_count with report=utilization and aggregate=sum, never an average of daily percentages.
netic_get_scheduler_leads is the dashboard's "online scheduler leads" export: scheduler sessions where the customer gave a phone or address, booked or not. Bounced means booked=no; for who still needs a call add exclude_recovered=true, which drops leads that booked online later or got a job through a later Netic call or text. netic_count and netic_export take report=scheduler_leads for breakdowns and full files. Follow-up contacts are checked by default; each result's followUp block says what was checked and gives a caveat (phone matches only, a window of repeat_window_days, possibly still open). Pass it on when it affects the answer or the user asks how "recovered" works.
Interactions need modality (call, inbound_text, recapture_text). Booking columns vary by provider (ServiceTitan, Cargas, or session-based). Outbound call transcripts are omitted inline unless include_transcript=true.
Rows contain customer names, phones, and addresses; do not repeat them beyond what the user asked for.`;

export function buildServer(env: NodeJS.ProcessEnv = process.env): McpServer {
  const ctx = createContext(env);
  const server = new McpServer({ name: SERVER_NAME, version: VERSION }, { instructions: INSTRUCTIONS });
  registerTenantTools(server, ctx);
  registerReportTools(server, ctx);
  registerLeadTools(server, ctx);
  registerAggregateTools(server, ctx);
  registerExportTools(server, ctx);
  registerRawTools(server, ctx);
  for (const warning of ctx.config.warnings) console.error(`[hbsg-netic] ${warning}`);
  if (ctx.tenantNames().length === 0) {
    console.error("[hbsg-netic] No tenants are configured; tools will return a configuration error until one is.");
  }
  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  await server.connect(withSchemaCompat(new StdioServerTransport()));
}

main().catch((err: unknown) => {
  console.error("[hbsg-netic] fatal:", err);
  process.exit(1);
});
