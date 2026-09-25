import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Row } from "../client.js";
import type { AppContext } from "../context.js";
import { REPORT_INFO, type Modality, type Report } from "../endpoints.js";
import { footer, markdownTable, textResult } from "../format.js";
import { rangeNotes, singleRangePage, walkRange } from "../paging.js";
import { inlineColumns, project, stripTranscripts, wherePredicate, type Where } from "../rows.js";
import { namePredicate, utilizationNotes, withBoardCell } from "../utilization.js";
import {
  READ_ONLY,
  agentIdsArg,
  endArg,
  fieldsArg,
  guarded,
  modalityArg,
  reportParams,
  snapshotDateArg,
  snapshotTimeArg,
  startArg,
  tenantArg,
  whereArg,
} from "./common.js";

const maxRowsArg = z
  .number()
  .int()
  .min(1)
  .max(5000)
  .default(500)
  .describe("Rows to return inline, fetched across as many pages as needed. Default 500. For totals use netic_count; for everything use netic_export.");
const pageArg = z.number().int().min(1).optional().describe("Fetch only this page (1-based) instead of auto-paging. Pair with page_size.");
const pageSizeArg = z.number().int().min(1).max(5000).optional().describe("Rows per page when page is set, 1 to 5000. Default 100.");

interface CommonArgs {
  tenant: string;
  start: string;
  end: string;
  fields?: string[] | undefined;
  where?: Where | undefined;
  max_rows: number;
  page?: number | undefined;
  page_size?: number | undefined;
  modality?: Modality | undefined;
  agent_ids?: Array<string | number> | undefined;
  include_transcript?: boolean | undefined;
  snapshot_date?: string | undefined;
  snapshot_time?: string | undefined;
}

async function runReport(ctx: AppContext, report: Report, args: CommonArgs, extraFilter?: (row: Row) => boolean) {
  const client = ctx.clientFor(args.tenant);
  const info = REPORT_INFO[report];
  const params = reportParams(report, args);
  const whereFn = wherePredicate(args.where);
  const filter = whereFn && extraFilter ? (r: Row) => whereFn(r) && extraFilter(r) : (whereFn ?? extraFilter);
  const before = client.requestCount;
  const result =
    args.page !== undefined
      ? await singleRangePage(client, report, params, args.start, args.end, args.page, args.page_size ?? 100, filter)
      : await walkRange(client, report, params, args.start, args.end, {
          pageSize: Math.min(5000, Math.max(args.max_rows, 100)),
          maxRows: args.max_rows,
          filter,
        });
  const apiCalls = client.requestCount - before;
  const stripped = stripTranscripts(result.rows, report, args.include_transcript ?? false);
  const rows = report === "utilization" ? withBoardCell(stripped) : stripped;
  const { columns, available } = inlineColumns(rows, report, args.fields);
  const notes = report === "utilization" ? utilizationNotes(result.extras) : [];
  notes.push(...rangeNotes(result, info.maxRangeDays));
  const lines = [
    `${info.label} for tenant ${client.tenant}${args.modality ? ` (modality ${args.modality})` : ""}.`,
    markdownTable(rows, columns),
  ];
  if (!args.fields && rows.length > 0 && available.length > columns.length) {
    lines.push(`Showing ${columns.length} of ${available.length} columns. All columns: ${available.join(", ")}. Pass fields to choose.`);
  }
  if (report === "outbound_calls" && !args.include_transcript) {
    lines.push("Transcripts omitted; pass include_transcript=true to include them (large).");
  }
  lines.push(
    footer({
      tenant: client.tenant,
      label: info.label,
      start: args.start,
      end: args.end,
      returned: rows.length,
      totalRecords: result.totalRecords,
      hasMore: result.hasMore,
      scanned: result.scanned,
      filtered: filter !== undefined,
      apiCalls,
      moreHint:
        args.page !== undefined
          ? `Request page ${args.page + 1} for more, or use netic_count or netic_export.`
          : "This is a sample: use netic_count for totals or netic_export for every row.",
      notes,
    }),
  );
  // Claude's client shows the model only structuredContent when it is present,
  // so the rows must be here, not just in the text.
  return textResult(lines.join("\n\n"), {
    tenant: client.tenant,
    report,
    start: args.start,
    end: args.end,
    ...result.extras,
    returned: rows.length,
    totalRecords: result.totalRecords,
    scanned: result.scanned,
    hasMore: result.hasMore,
    columns,
    rows: rows.map((r) => project(r, columns)),
    apiCalls,
  });
}

const DESCRIPTIONS: Record<Exclude<Report, "interactions" | "scheduler_sessions" | "outbound_calls" | "utilization">, { name: string; title: string; description: string }> = {
  scheduler_bookings: {
    name: "netic_get_scheduler_bookings",
    title: "Get Netic online scheduler bookings",
    description:
      "Jobs booked through the Netic online scheduler widget, with UTMs, click ids, landing page, and the booked job id. Columns differ by booking provider (ServiceTitan tenants carry service_titan_job_id and job_type_id; session-based tenants carry customer and address fields).",
  },
  tgl_bookings: {
    name: "netic_get_tgl_bookings",
    title: "Get Netic technician TGL bookings",
    description:
      "Technician 'turn the lead' bookings. Columns differ by provider (ServiceTitan: booked_at, job_id, technician_name, business units; Cargas: date, outcome_type, service_type, advisor_name). Tenants without TGL return no rows.",
  },
  referrer_bookings: {
    name: "netic_get_referrer_bookings",
    title: "Get Netic referrer (RGL) bookings",
    description: "Referral-generated-lead bookings attributed to a referrer email, with the ServiceTitan job id and status. Tenants without RGL return no rows.",
  },
};

const SUFFIX =
  " Dates are YYYY-MM-DD, both inclusive, tenant local time. Auto-pages up to max_rows; the footer shows rows returned of totalRecords and hasMore, so check it before treating the rows as complete.";

export function registerReportTools(server: McpServer, ctx: AppContext): void {
  const base = {
    tenant: tenantArg(ctx),
    start: startArg,
    end: endArg,
    fields: fieldsArg,
    where: whereArg,
    max_rows: maxRowsArg,
    page: pageArg,
    page_size: pageSizeArg,
  };

  server.registerTool(
    "netic_get_interactions",
    {
      title: "Get Netic inbound interactions",
      description:
        "Inbound interactions handled by Netic for one modality: calls, inbound texts, or recapture texts. One row per interaction with phone, date (MM/dd/yyyy HH:mm local), leadStatus, category (e.g. Booked), reason, trade, workType, triagedJobType, leadSource, click ids and UTMs, and ServiceTitan call and campaign ids." +
        SUFFIX,
      inputSchema: { ...base, modality: modalityArg },
      annotations: READ_ONLY,
    },
    guarded(async (args) => runReport(ctx, "interactions", args)),
  );

  server.registerTool(
    "netic_get_scheduler_sessions",
    {
      title: "Get Netic online scheduler sessions",
      description:
        "Online scheduler sessions, booked and abandoned: status (completed or abandoned), last_step (location, issue, details, customer, schedule, confirmation, booked), booked_from (rwg or website), blocker_type and blocker_detail (rejected zip), marketing_source, UTMs and click ids, and the customer's issue_description. Every value is a string." +
        SUFFIX,
      inputSchema: {
        ...base,
        status: z.string().optional().describe("Keep only this status, e.g. completed or abandoned. Filtered client-side."),
        last_step: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe("Keep only sessions whose last_step is this value or one of these, e.g. [\"schedule\",\"confirmation\"]. Filtered client-side."),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ status, last_step, ...args }) => {
      const where: Where = { ...(args.where ?? {}) };
      if (status) where.status = status;
      if (last_step) where.last_step = last_step;
      return runReport(ctx, "scheduler_sessions", { ...args, where: Object.keys(where).length > 0 ? where : undefined });
    }),
  );

  for (const report of ["scheduler_bookings", "tgl_bookings", "referrer_bookings"] as const) {
    const d = DESCRIPTIONS[report];
    server.registerTool(
      d.name,
      { title: d.title, description: d.description + SUFFIX, inputSchema: base, annotations: READ_ONLY },
      guarded(async (args) => runReport(ctx, report, args)),
    );
  }

  server.registerTool(
    "netic_get_outbound_calls",
    {
      title: "Get Netic outbound CSR calls",
      description:
        "Outbound calls placed by human CSRs in ServiceTitan, with AI summary, call type and reason, agent, duration, and any booked job id. Transcripts are omitted unless include_transcript=true, because they are very large." +
        SUFFIX,
      inputSchema: {
        ...base,
        agent_ids: agentIdsArg,
        include_transcript: z.boolean().default(false).describe("Include the transcript and analysis columns. Default false; keep max_rows small if true."),
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => runReport(ctx, "outbound_calls", args)),
  );

  server.registerTool(
    "netic_get_utilization",
    {
      title: "Get the Netic Utilization Board",
      description:
        "The Netic Utilization Board (Utilization > Board in the dashboard): how booked each business unit and group is, one row per unit or group per day. " +
        "percentBooked = job hours / available hours, rounded, where available = shift hours - non-job hours. Over 100% means overbooked and is shown as-is (217% happens). " +
        `The board cell is "N jobs · X%" (the board column here). percentBooked null is the board's "No shifts": no shift hours that day, even if jobs exist; 0% means shifts but nothing booked or no time left after non-job hours. ` +
        "Groups (type=group) roll up business units that share technicians, e.g. Blue Sky's HVAC Service group = the HVAC Service and HVAC Maintenance units; a member unit's groups column names its group. Group rows are not additive with their members, so never add a group to its units. " +
        "Live (default) is the board as it stands now, for any dates including past and future days. snapshot_date (and optionally snapshot_time) is the board's Point in time: the board as it stood at that moment, before later bookings, cancellations, and edits. " +
        "Dates are YYYY-MM-DD, both inclusive, tenant local time (America/Denver for Blue Sky, America/Chicago for the others). Netic allows 31 days per request; longer ranges are split automatically. For totals across days (e.g. weekly % booked per unit) use netic_count with aggregate=sum.",
      inputSchema: {
        tenant: tenantArg(ctx),
        start: startArg,
        end: endArg,
        snapshot_date: snapshotDateArg,
        snapshot_time: snapshotTimeArg,
        type: z.enum(["group", "business_unit"]).optional().describe("Keep only group rows or only business_unit rows. Filtered client-side."),
        name: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe('Keep only these business unit or group names, case-insensitive, surrounding spaces ignored, e.g. "HVAC Service" or ["Drains","Plumbing Service"].'),
        fields: fieldsArg,
        where: whereArg,
        max_rows: maxRowsArg,
        page: pageArg,
        page_size: pageSizeArg,
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ type, name, ...args }) => {
      const where: Where = { ...(args.where ?? {}) };
      if (type) where.type = type;
      return runReport(ctx, "utilization", { ...args, where: Object.keys(where).length > 0 ? where : undefined }, namePredicate(name));
    }),
  );
}
