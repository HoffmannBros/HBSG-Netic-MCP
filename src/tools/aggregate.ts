import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GroupCounter, GroupSummer } from "../aggregate.js";
import { NeticRequestError } from "../client.js";
import type { AppContext } from "../context.js";
import { REPORT_INFO, UTILIZATION_SUM_FIELDS } from "../endpoints.js";
import { footer, markdownTable, textResult } from "../format.js";
import { rangeNotes, walkRange } from "../paging.js";
import { wherePredicate } from "../rows.js";
import { NO_SHIFTS, utilizationNotes } from "../utilization.js";
import {
  READ_ONLY,
  agentIdsArg,
  endArg,
  guarded,
  modalityArg,
  reportArg,
  reportParams,
  snapshotDateArg,
  snapshotTimeArg,
  startArg,
  tenantArg,
  whereArg,
} from "./common.js";

export function registerAggregateTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "netic_count",
    {
      title: "Count Netic rows by field",
      description:
        'Answer "how many" questions without dumping rows: walks every page of a report for the date range and counts rows grouped by 1 to 3 columns, e.g. interactions by category and leadSource, or scheduler sessions by last_step. Blank values group as "(blank)". Use netic_get_* first if you need to see which columns a report has. ' +
        "For utilization, aggregate=sum totals jobs, jobHours, shiftHours, nonJobHours, and availableHours per group and recomputes percentBooked from the sums (job hours / available hours), never by averaging daily percentages; e.g. group_by [\"type\",\"name\"] gives each unit's and group's % booked over the range. Keep type in group_by or filter type in where: a group row already includes its member units, so adding both double counts. " +
        "Dates are YYYY-MM-DD, both inclusive, tenant local time.",
      inputSchema: {
        tenant: tenantArg(ctx),
        report: reportArg,
        modality: modalityArg.optional().describe("Required when report is interactions: call, inbound_text, or recapture_text."),
        start: startArg,
        end: endArg,
        group_by: z.array(z.string().min(1)).min(1).max(3).describe('Columns to group by, 1 to 3, e.g. ["category","leadSource"].'),
        aggregate: z
          .enum(["count", "sum"])
          .default("count")
          .describe("count (default) counts rows. sum is utilization only: totals jobs and hours and recomputes percentBooked per group."),
        where: whereArg,
        agent_ids: agentIdsArg,
        snapshot_date: snapshotDateArg,
        snapshot_time: snapshotTimeArg,
        top: z.number().int().min(1).max(1000).default(50).describe("Groups to show, largest first. Default 50; the total always covers every group."),
        max_rows: z
          .number()
          .int()
          .min(1)
          .max(1_000_000)
          .default(200_000)
          .describe("Safety cap on rows scanned. Default 200000; the footer says if it was hit."),
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      if (args.aggregate === "sum" && args.report !== "utilization") {
        throw new NeticRequestError("aggregate=sum applies only to report=utilization. Use aggregate=count for other reports.");
      }
      const client = ctx.clientFor(args.tenant);
      const info = REPORT_INFO[args.report];
      const params = reportParams(args.report, args);
      const sum = args.aggregate === "sum";
      const counter = new GroupCounter(args.group_by);
      const summer = new GroupSummer(args.group_by);
      const filter = wherePredicate(args.where);
      const before = client.requestCount;
      const result = await walkRange(client, args.report, params, args.start, args.end, {
        pageSize: 5000,
        maxRows: args.max_rows,
        filter,
        onRows: (rows) => (sum ? summer.addMany(rows) : counter.addMany(rows)),
      });
      const apiCalls = client.requestCount - before;
      const notes = args.report === "utilization" ? utilizationNotes(result.extras) : [];
      notes.push(...rangeNotes(result, info.maxRangeDays));
      const footerText = (total: number) =>
        footer({
          tenant: client.tenant,
          label: info.label,
          start: args.start,
          end: args.end,
          returned: total,
          totalRecords: result.totalRecords,
          hasMore: result.hasMore,
          scanned: result.scanned,
          filtered: filter !== undefined,
          apiCalls,
          moreHint: "The max_rows scan cap was hit, so the totals are partial. Raise max_rows or narrow the dates.",
          notes,
        });

      if (sum) {
        const groups = summer.groups();
        const shown = groups.slice(0, args.top);
        const tableRows = shown.map((g) => {
          const row: Record<string, unknown> = {};
          args.group_by.forEach((f, i) => (row[f] = g.values[i]));
          row.rows = g.rows;
          for (const f of UTILIZATION_SUM_FIELDS) row[f] = g.sums[f];
          row.percentBooked = g.percentBooked === null ? NO_SHIFTS : `${g.percentBooked}%`;
          return row;
        });
        const lines = [
          `Utilization totals for tenant ${client.tenant}: ${summer.total} row(s) summed into ${groups.length} group(s)${shown.length < groups.length ? `, top ${shown.length} by job hours shown` : ""}. percentBooked = jobHours / availableHours from the sums.`,
          markdownTable(tableRows, [...args.group_by, "rows", ...UTILIZATION_SUM_FIELDS, "percentBooked"]),
        ];
        if (summer.mixesTypes() && !args.group_by.includes("type")) {
          lines.push(
            'Warning: these totals mix group rows with business_unit rows. A group row already includes its member units, so hours are double counted. Add "type" to group_by or filter where {"type":"business_unit"} (or "group").',
          );
        }
        lines.push(footerText(summer.total));
        return textResult(lines.join("\n\n"), {
          tenant: client.tenant,
          report: args.report,
          aggregate: "sum",
          start: args.start,
          end: args.end,
          ...result.extras,
          groupBy: args.group_by,
          total: summer.total,
          groupCount: groups.length,
          groups: shown.map((g) => ({ values: g.values, rows: g.rows, ...g.sums, percentBooked: g.percentBooked })),
          mixesTypes: summer.mixesTypes(),
          totalRecords: result.totalRecords,
          scanned: result.scanned,
          hasMore: result.hasMore,
          apiCalls,
        });
      }

      const groups = counter.groups();
      const shown = groups.slice(0, args.top);
      const tableRows = shown.map((g) => {
        const row: Record<string, unknown> = {};
        args.group_by.forEach((f, i) => (row[f] = g.values[i]));
        row.count = g.count;
        row.share = counter.total > 0 ? `${((100 * g.count) / counter.total).toFixed(1)}%` : "";
        return row;
      });
      const missing = args.group_by.filter((f) => counter.total > 0 && groups.every((g) => g.values[args.group_by.indexOf(f)] === "(blank)"));
      const lines = [
        `${counter.total} ${info.label} for tenant ${client.tenant}${args.modality ? ` (modality ${args.modality})` : ""}, in ${groups.length} group(s)${shown.length < groups.length ? `, top ${shown.length} shown` : ""}.`,
        markdownTable(tableRows, [...args.group_by, "count", "share"]),
      ];
      if (missing.length > 0) {
        lines.push(`Every row is blank for ${missing.join(", ")}. Check the column name; names are case-sensitive and vary by booking provider.`);
      }
      lines.push(footerText(counter.total));
      return textResult(lines.join("\n\n"), {
        tenant: client.tenant,
        report: args.report,
        aggregate: "count",
        start: args.start,
        end: args.end,
        ...result.extras,
        groupBy: args.group_by,
        total: counter.total,
        groupCount: groups.length,
        groups: shown.map((g) => ({ values: g.values, count: g.count })),
        totalRecords: result.totalRecords,
        scanned: result.scanned,
        hasMore: result.hasMore,
        apiCalls,
      });
    }),
  );
}
