import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RowSpool, sanitizeFilename } from "../csv.js";
import type { AppContext } from "../context.js";
import { REPORT_INFO, TRANSCRIPT_COLUMNS } from "../endpoints.js";
import { footer, formatBytes, markdownTable, textResult } from "../format.js";
import { rangeNotes, walkRange } from "../paging.js";
import { dropColumns, project, wherePredicate } from "../rows.js";
import { utilizationNotes } from "../utilization.js";
import {
  READ_ONLY,
  agentIdsArg,
  endArg,
  fieldsArg,
  filenameArg,
  guarded,
  modalityArg,
  outputDirArg,
  reportArg,
  reportParams,
  resolveOutputDir,
  snapshotDateArg,
  snapshotTimeArg,
  startArg,
  tenantArg,
  whereArg,
  withExtension,
} from "./common.js";

export function registerExportTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "netic_export",
    {
      title: "Export a Netic report to a file",
      description:
        "Pull every page of a report for the date range into a CSV or JSON file in the export folder, and return the path, row count, columns, and a short preview. Use this for full or large pulls instead of netic_get_*. CSV is UTF-8 with a BOM for Excel. Existing files are never overwritten. Dates are YYYY-MM-DD, both inclusive, tenant local time. Utilization ranges over 31 days are split into several requests automatically.",
      inputSchema: {
        tenant: tenantArg(ctx),
        report: reportArg,
        modality: modalityArg.optional().describe("Required when report is interactions: call, inbound_text, or recapture_text."),
        start: startArg,
        end: endArg,
        format: z.enum(["csv", "json"]).default("csv").describe("csv (default) or json (an array of row objects)."),
        fields: fieldsArg.describe("Columns to write, in order. Omit to write every column."),
        where: whereArg,
        agent_ids: agentIdsArg,
        snapshot_date: snapshotDateArg,
        snapshot_time: snapshotTimeArg,
        include_transcript: z.boolean().default(true).describe("Outbound calls only: write the transcript and analysis columns. Default true, since they go to a file."),
        max_rows: z.number().int().min(1).max(2_000_000).default(1_000_000).describe("Safety cap on rows written. Default 1000000."),
        filename: filenameArg,
        output_dir: outputDirArg,
        bom: z.boolean().default(true).describe("CSV only: prefix a UTF-8 BOM so Excel on Windows opens it correctly. Default true."),
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      const client = ctx.clientFor(args.tenant);
      const info = REPORT_INFO[args.report];
      const params = reportParams(args.report, args);
      const dir = resolveOutputDir(ctx, args.output_dir);
      const spool = await RowSpool.create({ dir, initialColumns: args.fields ?? [] });
      const dropTranscripts = args.report === "outbound_calls" && !args.include_transcript;
      const preview: Array<Record<string, unknown>> = [];
      const before = client.requestCount;
      let result;
      try {
        result = await walkRange(client, args.report, params, args.start, args.end, {
          pageSize: 5000,
          maxRows: args.max_rows,
          filter: wherePredicate(args.where),
          onRows: async (rows) => {
            for (const raw of rows) {
              const trimmed = dropTranscripts ? dropColumns(raw, TRANSCRIPT_COLUMNS) : raw;
              const row = args.fields ? project(trimmed, args.fields) : trimmed;
              if (preview.length < 5) preview.push(row);
              await spool.push(row);
            }
          },
        });
      } catch (err) {
        await spool.discard();
        throw err;
      }
      const apiCalls = client.requestCount - before;
      const name =
        args.filename ??
        `netic_${client.tenant}_${args.report}${args.modality ? `_${args.modality}` : ""}_${args.start}_${args.end}`;
      const out = await spool.finalize(withExtension(sanitizeFilename(name), args.format), { format: args.format, bom: args.bom });
      const previewColumns = out.columns.filter((c) => !(TRANSCRIPT_COLUMNS as readonly string[]).includes(c)).slice(0, 10);
      const text = [
        `Wrote ${out.rows} ${info.label} row(s) for tenant ${client.tenant} to ${out.path} (${formatBytes(out.bytes)}).`,
        `Columns (${out.columns.length}): ${out.columns.join(", ")}`,
        out.rows > 0 ? `Preview:\n\n${markdownTable(preview, previewColumns, 80)}` : "",
        footer({
          tenant: client.tenant,
          label: info.label,
          start: args.start,
          end: args.end,
          returned: out.rows,
          totalRecords: result.totalRecords,
          hasMore: result.hasMore,
          scanned: result.scanned,
          filtered: args.where !== undefined,
          apiCalls,
          moreHint: "The max_rows cap was hit, so the file is partial. Raise max_rows or split the dates.",
          notes: [
            ...(args.report === "utilization" ? utilizationNotes(result.extras) : []),
            ...rangeNotes(result, info.maxRangeDays),
          ],
        }),
      ]
        .filter(Boolean)
        .join("\n\n");
      return textResult(text, {
        tenant: client.tenant,
        report: args.report,
        path: out.path,
        rows: out.rows,
        columns: out.columns,
        bytes: out.bytes,
        ...result.extras,
        preview: preview.map((r) => project(r, previewColumns)),
        totalRecords: result.totalRecords,
        hasMore: result.hasMore,
        apiCalls,
      });
    }),
  );
}
