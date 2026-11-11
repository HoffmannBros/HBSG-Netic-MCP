import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GroupAverager, GroupCounter, GroupSummer } from "../aggregate.js";
import { NeticRequestError, type Row } from "../client.js";
import type { AppContext } from "../context.js";
import { REPORT_INFO, UTILIZATION_SUM_FIELDS } from "../endpoints.js";
import { footer, markdownTable, textResult } from "../format.js";
import { rangeNotes, walkRange } from "../paging.js";
import { BLANK, RowScan, columnWarnings, type ColumnSource } from "../rows.js";
import { NO_SHIFTS, utilizationNotes } from "../utilization.js";
import { LEADS_LABEL, LEADS_REPORT, checkContactsArg, collectLeads, repeatWindowArg, type FollowUpInfo } from "./leads.js";
import { SCORECARD_LABEL, SCORECARD_REPORT, walkScorecardItems } from "./scorecard.js";
import {
  READ_ONLY,
  agentIdsArg,
  endArg,
  guarded,
  countReportArg,
  modalityArg,
  reportParams,
  snapshotDateArg,
  snapshotTimeArg,
  startArg,
  tenantArg,
  whereArg,
} from "./common.js";

const MIXED_TYPES_WARNING =
  'these totals mix group rows with business_unit rows. A group row already includes its member units, so hours are double counted. Add "type" to group_by or filter where {"type":"business_unit"} (or "group").';

export function registerAggregateTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "netic_count",
    {
      title: "Count Netic rows by field",
      description:
        'Answer "how many" questions without dumping rows: walks every page of a report for the date range and counts rows grouped by 1 to 3 columns, e.g. interactions by category and leadSource, or scheduler sessions by last_step. Blank values group as "(blank)". ' +
        "Column names are case-sensitive and vary by report and booking provider: any netic_get_* result lists them as availableColumns, and a group_by, where, or value name that no row has comes back in warnings (with the available columns), not as an error, so read warnings before stating a number. " +
        "aggregate=avg averages one numeric column (value) per group, for any report: strings that parse as numbers count, blanks and text are skipped and reported as skipped. Each group gives rows, n (values averaged), avg, min, and max, rounded to 3 decimals, largest group first. " +
        "Outbound CSR call QA: report=outbound_calls has qa_score (Netic's AI grade of the human CSR's call, 0 to 1), qa_is_lead, qa_is_booked, qa_is_flagged, qa_is_excused, e.g. aggregate=avg value=qa_score group_by [\"agent_name\"], or count group_by [\"agent_name\",\"qa_is_flagged\"]. " +
        "report=outbound_scorecard_items has one row per applicable scorecard item (section, item, score, agent_name, agent_id, call_placed_at, service_titan_call_id, job_id), so aggregate=avg value=score group_by [\"section\",\"item\"] shows which items CSRs miss most (lowest avg), and adding agent_name shows it per CSR. " +
        "For utilization, aggregate=sum totals jobs, jobHours, shiftHours, nonJobHours, and availableHours per group and recomputes percentBooked from the sums (job hours / available hours), never by averaging daily percentages; e.g. group_by [\"type\",\"name\"] gives each unit's and group's % booked over the range. Keep type in group_by or filter type in where: a group row already includes its member units, so adding both double counts. " +
        "Dates are YYYY-MM-DD, both inclusive, tenant local time.",
      inputSchema: {
        tenant: tenantArg(ctx),
        report: countReportArg,
        modality: modalityArg.optional().describe("Required when report is interactions: call, inbound_text, or recapture_text."),
        start: startArg,
        end: endArg,
        group_by: z.array(z.string().min(1)).min(1).max(3).describe('Columns to group by, 1 to 3, e.g. ["category","leadSource"].'),
        aggregate: z
          .enum(["count", "sum", "avg"])
          .default("count")
          .describe("count (default) counts rows. sum is utilization only: totals jobs and hours and recomputes percentBooked per group. avg averages the value column per group (any report)."),
        value: z
          .string()
          .min(1)
          .optional()
          .describe('aggregate=avg only, and required there: the numeric column to average, e.g. "qa_score" or "call_duration_seconds" (outbound_calls) or "score" (outbound_scorecard_items).'),
        where: whereArg,
        agent_ids: agentIdsArg,
        snapshot_date: snapshotDateArg,
        snapshot_time: snapshotTimeArg,
        check_contacts: checkContactsArg.describe("scheduler_leads only: " + (checkContactsArg.description ?? "")),
        repeat_window_days: repeatWindowArg.describe("scheduler_leads only: " + (repeatWindowArg.description ?? "")),
        top: z.number().int().min(1).max(1000).default(50).describe("Groups to show, largest first. Default 50; the total always covers every group."),
        max_rows: z
          .number()
          .int()
          .min(1)
          .max(1_000_000)
          .default(200_000)
          .describe("Safety cap on rows scanned (calls, for outbound_scorecard_items). Default 200000; the footer says if it was hit."),
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      if (args.aggregate === "sum" && args.report !== "utilization") {
        throw new NeticRequestError("aggregate=sum applies only to report=utilization. Use aggregate=count for other reports.");
      }
      if (args.aggregate === "avg" && !args.value) {
        throw new NeticRequestError('aggregate=avg needs value: the numeric column to average, e.g. "qa_score".');
      }
      if (args.value && args.aggregate !== "avg") {
        throw new NeticRequestError("value applies only to aggregate=avg.");
      }
      const client = ctx.clientFor(args.tenant);
      const counter = new GroupCounter(args.group_by);
      const summer = new GroupSummer(args.group_by);
      const averager = new GroupAverager(args.group_by, args.value ?? "");
      const target = args.aggregate === "sum" ? summer : args.aggregate === "avg" ? averager : counter;
      const sink = (rows: Iterable<Row>) => target.addMany(rows);
      let label: string;
      let result: { totalRecords: number; hasMore: boolean; scanned: number; extras: Record<string, unknown> };
      let filtered: boolean;
      let apiCalls: number;
      let notes: string[];
      let followUp: FollowUpInfo | undefined;
      let source: ColumnSource;
      if (args.report === LEADS_REPORT) {
        const leads = await collectLeads(client, args);
        sink(leads.rows);
        label = LEADS_LABEL;
        result = { totalRecords: leads.totalRecords, hasMore: false, scanned: leads.scanned, extras: {} };
        filtered = true;
        apiCalls = leads.apiCalls;
        notes = leads.notes;
        followUp = leads.followUp;
        source = leads.source;
      } else if (args.report === SCORECARD_REPORT) {
        const items = await walkScorecardItems(client, args, sink);
        label = SCORECARD_LABEL;
        result = items.walked;
        filtered = true;
        apiCalls = items.apiCalls;
        notes = [`${items.items} applicable scorecard item(s) from ${items.walked.scanned} call(s); scanned and totalRecords count calls`];
        source = items.source;
      } else {
        const info = REPORT_INFO[args.report];
        const params = reportParams(args.report, args);
        const scan = new RowScan(args.report, { where: args.where, watch: [...args.group_by, args.value] });
        const before = client.requestCount;
        const walked = await walkRange(client, args.report, params, args.start, args.end, {
          pageSize: 5000,
          maxRows: args.max_rows,
          filter: scan.filter,
          onRows: sink,
        });
        result = walked;
        label = info.label;
        filtered = scan.filtered;
        apiCalls = client.requestCount - before;
        notes = args.report === "utilization" ? utilizationNotes(result.extras) : [];
        notes.push(...rangeNotes(walked, info.maxRangeDays));
        source = scan;
      }
      const warnings = columnWarnings(source, { where: args.where, groupBy: args.group_by, value: args.value });
      const footerText = (total: number) =>
        footer({
          tenant: client.tenant,
          label,
          start: args.start,
          end: args.end,
          returned: total,
          totalRecords: result.totalRecords,
          hasMore: result.hasMore,
          scanned: result.scanned,
          filtered,
          apiCalls,
          moreHint: "The max_rows scan cap was hit, so the totals are partial. Raise max_rows or narrow the dates.",
          notes,
        });
      const head = { tenant: client.tenant, report: args.report, aggregate: args.aggregate, start: args.start, end: args.end, ...result.extras, groupBy: args.group_by };
      const tail = { totalRecords: result.totalRecords, scanned: result.scanned, hasMore: result.hasMore, notes, warnings, apiCalls };
      const groupCells = (values: string[]) => Object.fromEntries(args.group_by.map((f, i) => [f, values[i]]));

      if (args.aggregate === "sum") {
        if (summer.mixesTypes() && !args.group_by.includes("type")) warnings.push(MIXED_TYPES_WARNING);
        const groups = summer.groups();
        const shown = groups.slice(0, args.top);
        const tableRows = shown.map((g) => ({
          ...groupCells(g.values),
          rows: g.rows,
          ...g.sums,
          percentBooked: g.percentBooked === null ? NO_SHIFTS : `${g.percentBooked}%`,
        }));
        const lines = [
          `Utilization totals for tenant ${client.tenant}: ${summer.total} row(s) summed into ${groups.length} group(s)${shown.length < groups.length ? `, top ${shown.length} by job hours shown` : ""}. percentBooked = jobHours / availableHours from the sums.`,
          markdownTable(tableRows, [...args.group_by, "rows", ...UTILIZATION_SUM_FIELDS, "percentBooked"]),
          ...warnings.map((w) => `Warning: ${w}`),
          footerText(summer.total),
        ];
        return textResult(lines.join("\n\n"), {
          ...head,
          total: summer.total,
          groupCount: groups.length,
          groups: shown.map((g) => ({ values: g.values, rows: g.rows, ...g.sums, percentBooked: g.percentBooked })),
          mixesTypes: summer.mixesTypes(),
          ...tail,
        });
      }

      if (args.aggregate === "avg") {
        const value = args.value ?? "";
        const groups = averager.groups();
        const shown = groups.slice(0, args.top);
        const overall = averager.overall();
        if (averager.total > 0 && overall.n === 0 && source.has(value)) {
          warnings.push(`No row has a number in ${value}, so there is no average. Pick a numeric column.`);
        }
        const tableRows = shown.map((g) => ({ ...groupCells(g.values), rows: g.rows, n: g.n, avg: g.avg, min: g.min, max: g.max }));
        const lines = [
          `Average of ${value} over ${overall.n} of ${averager.total} ${label} for tenant ${client.tenant}${args.modality ? ` (modality ${args.modality})` : ""}: ${overall.avg ?? "none"}, in ${groups.length} group(s)${shown.length < groups.length ? `, top ${shown.length} by rows shown` : ""}. ${averager.skipped} row(s) skipped (blank or not a number). avg, min, and max are rounded to 3 decimals; n is the values averaged.`,
          markdownTable(tableRows, [...args.group_by, "rows", "n", "avg", "min", "max"]),
          ...warnings.map((w) => `Warning: ${w}`),
          footerText(averager.total),
        ];
        return textResult(lines.join("\n\n"), {
          ...head,
          value,
          total: averager.total,
          n: overall.n,
          avg: overall.avg,
          skipped: averager.skipped,
          groupCount: groups.length,
          groups: shown,
          ...(followUp ? { followUp } : {}),
          ...tail,
        });
      }

      const groups = counter.groups();
      const shown = groups.slice(0, args.top);
      const tableRows = shown.map((g) => ({
        ...groupCells(g.values),
        count: g.count,
        share: counter.total > 0 ? `${((100 * g.count) / counter.total).toFixed(1)}%` : "",
      }));
      // A column that exists but is blank on every counted row; absent columns are already warned about.
      const blank = args.group_by.filter((f, i) => counter.total > 0 && source.has(f) && groups.every((g) => g.values[i] === BLANK));
      if (blank.length > 0) warnings.push(`Every row is blank for ${blank.join(", ")}. The column exists but has no values in these rows.`);
      const lines = [
        `${counter.total} ${label} for tenant ${client.tenant}${args.modality ? ` (modality ${args.modality})` : ""}, in ${groups.length} group(s)${shown.length < groups.length ? `, top ${shown.length} shown` : ""}.`,
        markdownTable(tableRows, [...args.group_by, "count", "share"]),
        ...warnings.map((w) => `Warning: ${w}`),
        footerText(counter.total),
      ];
      return textResult(lines.join("\n\n"), {
        ...head,
        total: counter.total,
        groupCount: groups.length,
        groups: shown.map((g) => ({ values: g.values, count: g.count })),
        ...(followUp ? { followUp } : {}),
        ...tail,
      });
    }),
  );
}
