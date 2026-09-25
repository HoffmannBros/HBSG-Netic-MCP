import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fsp from "node:fs/promises";
import { z } from "zod";
import { isEnvelope } from "../client.js";
import type { AppContext } from "../context.js";
import { sanitizeFilename, uniquePath } from "../csv.js";
import { PATH_PREFIX, REPORT_INFO } from "../endpoints.js";
import { formatBytes, textResult } from "../format.js";
import { READ_ONLY, guarded, outputDirArg, resolveOutputDir, tenantArg, withExtension } from "./common.js";

const KNOWN_PATHS = Object.values(REPORT_INFO)
  .map((r) => r.path)
  .join(", ");

export function registerRawTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "netic_api_call",
    {
      title: "Call the Netic API directly",
      description: `Escape hatch for anything the typed tools do not cover. GET only; the path must start with ${PATH_PREFIX}, and web/leads (which submits real leads) is refused. Known paths: ${KNOWN_PATHS}. Params use the API's own names: createdOnOrAfter and createdBefore (YYYY-MM-DD, both inclusive), page, pageSize (1 to 5000), modality, agentId. Outbound calls always get format=json. No auto-paging; data arrays are capped inline by max_items, and save_as writes the full response to a JSON file.`,
      inputSchema: {
        tenant: tenantArg(ctx),
        path: z.string().regex(/^\/api\/public\/metrics\//).describe(`Request path starting with ${PATH_PREFIX}.`),
        params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Query parameters, by the API's names."),
        max_items: z.number().int().min(1).max(5000).default(50).describe("Maximum data rows to return inline. Default 50."),
        save_as: z.string().optional().describe("File name to save the full JSON response into the export folder."),
        output_dir: outputDirArg,
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ tenant, path, params, max_items, save_as, output_dir }) => {
      const client = ctx.clientFor(tenant);
      const before = client.requestCount;
      const data = await client.get<unknown>(path, params ?? {});
      const apiCalls = client.requestCount - before;
      let savedPath: string | undefined;
      let savedBytes = 0;
      if (save_as) {
        const dir = resolveOutputDir(ctx, output_dir);
        await fsp.mkdir(dir, { recursive: true });
        savedPath = await uniquePath(dir, withExtension(sanitizeFilename(save_as), "json"));
        const body = JSON.stringify(data, null, 2);
        await fsp.writeFile(savedPath, body, "utf8");
        savedBytes = Buffer.byteLength(body);
      }
      const saved = savedPath ? `Saved full response to ${savedPath} (${formatBytes(savedBytes)}).` : "";
      if (isEnvelope(data)) {
        const shown = data.data.slice(0, max_items);
        const p = data.pagination;
        const text = [
          `${data.data.length} row(s) on this page from ${path} for tenant ${client.tenant}${shown.length < data.data.length ? `, showing ${shown.length}` : ""}. ${apiCalls} API call(s).`,
          saved,
          "```json",
          JSON.stringify(shown, null, 2),
          "```",
          `---\ntenant ${client.tenant} · page ${p.page} of ${p.totalPages} · pageSize ${p.pageSize} · totalRecords ${p.totalRecords} · hasMore: ${p.hasMore}`,
        ]
          .filter(Boolean)
          .join("\n\n");
        return textResult(text, { tenant: client.tenant, path, pagination: p, returned: shown.length, savedPath, apiCalls });
      }
      const text = [`Response from ${path} for tenant ${client.tenant}. ${apiCalls} API call(s).`, saved, "```json", JSON.stringify(data, null, 2).slice(0, 20_000), "```"]
        .filter(Boolean)
        .join("\n\n");
      return textResult(text, { tenant: client.tenant, path, savedPath, apiCalls });
    }),
  );
}
