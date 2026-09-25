import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { textResult } from "../format.js";
import { READ_ONLY, TENANT_LABELS, guarded } from "./common.js";

export function registerTenantTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "netic_list_tenants",
    {
      title: "List Netic tenants",
      description:
        "List the Netic tenant names configured in this extension (names only, never tokens). Every other tool needs one of these as tenant; there is no default, so call this when the user has not said which brand.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guarded(async () => {
      const tenants = ctx.tenantNames().map((name) => ({ name, label: TENANT_LABELS[name] ?? name }));
      const text =
        tenants.length === 0
          ? "No Netic tenants are configured. In Claude Desktop open Settings, Extensions, Netic and fill in a tenant name and token."
          : [`${tenants.length} tenant(s) configured:`, ...tenants.map((t) => `- ${t.name}: ${t.label}`)].join("\n");
      return textResult(text, { tenants });
    }),
  );
}
