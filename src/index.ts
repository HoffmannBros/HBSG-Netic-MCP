import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContext } from "./context.js";
import { withSchemaCompat } from "./schema-compat.js";
import { registerAggregateTools } from "./tools/aggregate.js";
import { registerExportTools } from "./tools/export.js";
import { registerRawTools } from "./tools/raw.js";
import { registerReportTools } from "./tools/reports.js";
import { registerTenantTools } from "./tools/tenants.js";
import { SERVER_NAME, VERSION } from "./version.js";

const INSTRUCTIONS = `Netic is the AI voice agent, texting, and online booking platform used by Hoffmann Brothers' brands. This server reads its Reports Export API, the same rows as the Netic dashboard CSV exports.
Every tool needs tenant, one brand per tenant (stl Hoffmann STL, nash Hoffmann NSH, blue Blue Sky, ferg Ferguson STL). There is no default: if the user did not name a brand, ask, or call netic_list_tenants.
Dates are YYYY-MM-DD and both bounds are inclusive in the tenant's local time; one day is start = end.
For "how many" questions use netic_count, which walks every page and groups by up to three columns. For full pulls use netic_export. The netic_get_* tools return a sample capped by max_rows: read the footer (rows returned of totalRecords, hasMore) before stating totals from them.
Interactions need modality (call, inbound_text, recapture_text). Booking columns vary by provider (ServiceTitan, Cargas, or session-based). Outbound call transcripts are omitted inline unless include_transcript=true.
Rows contain customer names, phones, and addresses; do not repeat them beyond what the user asked for.`;

export function buildServer(env: NodeJS.ProcessEnv = process.env): McpServer {
  const ctx = createContext(env);
  const server = new McpServer({ name: SERVER_NAME, version: VERSION }, { instructions: INSTRUCTIONS });
  registerTenantTools(server, ctx);
  registerReportTools(server, ctx);
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
