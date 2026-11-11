import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GroupCounter } from "../aggregate.js";
import { NeticRequestError, type NeticClient, type Row } from "../client.js";
import { expandPathTokens } from "../config.js";
import type { AppContext } from "../context.js";
import { footer, textResult } from "../format.js";
import { neticTenantName } from "../leads.js";
import { walkRange } from "../paging.js";
import { RowScan, columnWarnings, project, type ColumnSource, type Where } from "../rows.js";
import {
  EXPORT_HOWTO,
  INBOUND_SPEAKERS,
  OUTBOUND_SPEAKERS,
  TranscriptSourceError,
  apiStats,
  apiTranscript,
  attachTranscripts,
  buildMatcher,
  findDrilldownCsv,
  joinNotes,
  loadDrilldown,
  searchable,
  seededShuffle,
  snippets,
  truncate,
  type JoinStats,
  type SpeakerLabels,
} from "../transcripts.js";
import { READ_ONLY, agentIdsArg, endArg, guarded, reportParams, startArg, tenantArg, whereArg } from "./common.js";

const LABEL = "inbound AI call transcripts";
const OUTBOUND_LABEL = "outbound CSR call transcripts";

/** Call metadata shown beside a transcript or snippet. */
export const CALL_COLUMNS = [
  "id",
  "date",
  "phoneNumber",
  "leadStatus",
  "category",
  "reason",
  "subReason",
  "trade",
  "workType",
  "jobId",
  "callDurationTotal",
  "transferredTo",
  "postTransferOutcome",
  "serviceTitanCallId",
] as const;

/** The same for outbound CSR calls, including the derived scorecard columns. */
export const OUTBOUND_CALL_COLUMNS = [
  "id",
  "call_placed_at",
  "agent_name",
  "agent_id",
  "call_type",
  "call_reason",
  "call_duration_seconds",
  "job_id",
  "service_titan_call_id",
  "qa_score",
  "qa_is_booked",
  "qa_is_flagged",
] as const;

export const csvPathArg = z
  .string()
  .optional()
  .describe(
    "Path to a Calls Drill Down CSV from the Netic dashboard. Omit to use the newest drilldown_export*.csv for this tenant in the transcript folder (default Downloads). Supports ${HOME}, ${DOWNLOADS}, and the like.",
  );

const sourceArg = z
  .enum(["inbound", "outbound"])
  .default("inbound")
  .describe(
    "inbound (default): calls to the Netic AI agent, transcripts from the Calls Drill Down CSV, speakers Agent and User. outbound: human CSR calls placed from ServiceTitan, transcripts straight from the API, speakers CXR (the CSR) and Customer; no CSV needed.",
  );

type Source = "inbound" | "outbound";

export interface CallsWithTranscripts {
  client: NeticClient;
  rows: Row[];
  stats: JoinStats;
  totalRecords: number;
  scanned: number;
  hasMore: boolean;
  apiCalls: number;
}

interface CallSet extends CallsWithTranscripts {
  label: string;
  speakers: SpeakerLabels;
  /** Columns of every scanned call, for unknown-column warnings. */
  scan: ColumnSource;
  meta(row: Row): Row;
  heading(row: Row): string;
  /** Whether an id from the caller names this call. */
  idOf(row: Row): string[];
}

/**
 * Attach transcripts to interaction rows already fetched: the API's own
 * field if Netic ever sends one, else the Calls Drill Down CSV. Refuses a
 * CSV for another tenant.
 */
export async function withTranscripts(ctx: AppContext, client: NeticClient, rows: Row[], csvPath: string | undefined): Promise<{ rows: Row[]; stats: JoinStats }> {
  if (rows.length === 0 || rows.some((r) => apiTranscript(r) !== undefined)) return attachTranscripts(rows, undefined);
  const tenantName = typeof rows[0]!.tenant === "string" && rows[0]!.tenant ? rows[0]!.tenant : neticTenantName(client.tenant);
  const file = csvPath ? expandPathTokens(csvPath) : await findDrilldownCsv(ctx.config.transcriptDir, tenantName);
  const drilldown = await loadDrilldown(file);
  if (drilldown.tenant.trim().toLowerCase() !== tenantName.trim().toLowerCase()) {
    throw new TranscriptSourceError(`${file} is a ${drilldown.tenant} export, but tenant ${client.tenant} is ${tenantName}. Export the Calls Drill Down for ${tenantName}.`);
  }
  return attachTranscripts(rows, drilldown);
}

interface CollectArgs {
  tenant: string;
  start: string;
  end: string;
  where?: Where | undefined;
  csv_path?: string | undefined;
  source?: Source | undefined;
  agent_ids?: Array<string | number> | undefined;
  group_by?: string[] | undefined;
}

/**
 * Every call of the source in the range (optionally filtered), with
 * transcripts in `transcript`: inbound joined from the Drill Down CSV,
 * outbound as the API sent them.
 */
async function collectCalls(ctx: AppContext, args: CollectArgs): Promise<CallSet> {
  const client = ctx.clientFor(args.tenant);
  const source = args.source ?? "inbound";
  const before = client.requestCount;
  if (source === "outbound") {
    if (args.csv_path) throw new NeticRequestError("csv_path applies only to source=inbound; outbound transcripts come from the API.");
    const scan = new RowScan("outbound_calls", { where: args.where, watch: args.group_by });
    const walked = await walkRange(client, "outbound_calls", reportParams("outbound_calls", args), args.start, args.end, {
      pageSize: 5000,
      maxRows: 1_000_000,
      filter: scan.filter,
    });
    return {
      client,
      rows: walked.rows,
      stats: apiStats(walked.rows),
      totalRecords: walked.totalRecords,
      scanned: walked.scanned,
      hasMore: walked.hasMore,
      apiCalls: client.requestCount - before,
      label: OUTBOUND_LABEL,
      speakers: OUTBOUND_SPEAKERS,
      scan,
      meta: (row) => project(row, [...OUTBOUND_CALL_COLUMNS]),
      heading: (r) => `${r.call_placed_at} · ${r.agent_name} · qa_score ${r.qa_score ?? "none"}${r.qa_is_flagged === true ? " (flagged)" : ""} · id ${r.id}`,
      idOf: (r) => [String(r.id ?? ""), String(r.service_titan_call_id ?? "")],
    };
  }
  if (args.agent_ids) throw new NeticRequestError("agent_ids applies only to source=outbound.");
  const scan = new RowScan("interactions", { where: args.where, watch: args.group_by });
  const walked = await walkRange(client, "interactions", { modality: "call", createdOnOrAfter: args.start, createdBefore: args.end }, args.start, args.end, {
    pageSize: 5000,
    maxRows: 1_000_000,
    filter: scan.filter,
  });
  const joined = await withTranscripts(ctx, client, walked.rows, args.csv_path);
  return {
    client,
    rows: joined.rows,
    stats: joined.stats,
    totalRecords: walked.totalRecords,
    scanned: walked.scanned,
    hasMore: walked.hasMore,
    apiCalls: client.requestCount - before,
    label: LABEL,
    speakers: INBOUND_SPEAKERS,
    scan,
    meta: (row) => project(row, [...CALL_COLUMNS]),
    heading: (r) => `${r.date} · ${r.category} · ${r.reason} / ${r.subReason} · id ${r.id}`,
    idOf: (r) => [String(r.id ?? ""), String(r.serviceTitanCallId ?? "")],
  };
}

export function registerTranscriptTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "netic_search_call_transcripts",
    {
      title: "Search Netic call transcripts",
      description:
        "Search what was said on calls, and count the matching calls by any call column. Returns the number of matching calls, grouped counts over every match, and up to max_results calls with their outcome columns and short snippets around each hit. Use it for \"how many calls mention X, by outcome\" and for finding examples; follow up with netic_get_call_transcripts (by id, same source) to read whole calls. " +
        "source=inbound (default) searches calls to the Netic AI agent (speaker agent = the AI, user = the caller); group_by takes interaction columns such as category or reason. Inbound transcripts come from the dashboard's Calls Drill Down CSV until Netic adds them to the API: " +
        EXPORT_HOWTO +
        " source=outbound searches human CSR calls placed from ServiceTitan, straight from the API (speaker agent = the CSR, shown as CXR; user = the customer); group_by defaults to agent_name and takes outbound columns including the qa_* scorecard columns, e.g. [\"agent_name\",\"qa_is_flagged\"]. " +
        "The footer says where transcripts came from and how many calls had none; warnings name any where or group_by column no call has. Dates are YYYY-MM-DD, both inclusive, tenant local time. Transcripts contain customer names, phones, and addresses.",
      inputSchema: {
        tenant: tenantArg(ctx),
        start: startArg,
        end: endArg,
        source: sourceArg,
        query: z
          .string()
          .min(1)
          .describe('Words to find, case-insensitive; quote a phrase to keep it together, e.g. membership "tune up". With regex=true, one JavaScript regular expression.'),
        match: z.enum(["any", "all"]).default("any").describe("any (default): a call matches if it has any term. all: it must have every term (anywhere in the call)."),
        regex: z.boolean().default(false).describe("Treat query as a regular expression (case-insensitive)."),
        speaker: z
          .enum(["any", "agent", "user"])
          .default("any")
          .describe("Search only the customer's side (user: the caller, or Customer on outbound), only the call handler's (agent: the AI agent, or the CSR, CXR, on outbound), or both (any, default)."),
        where: whereArg,
        group_by: z
          .array(z.string().min(1))
          .min(1)
          .max(3)
          .optional()
          .describe('Columns to count matches by, e.g. ["category"] or ["reason","subReason"] (inbound, default ["category"]) or ["agent_name"] (outbound, the default).'),
        agent_ids: agentIdsArg.describe("source=outbound only: restrict to these ServiceTitan agent (CSR) ids."),
        max_results: z.number().int().min(0).max(500).default(50).describe("Matching calls to list, oldest first. Default 50; counts always cover every match."),
        snippets_per_call: z.number().int().min(1).max(5).default(2).describe("Snippets per call. Default 2."),
        snippet_chars: z.number().int().min(40).max(600).default(160).describe("Approximate snippet width in characters. Default 160."),
        csv_path: csvPathArg.describe("source=inbound only. " + (csvPathArg.description ?? "")),
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      const calls = await collectCalls(ctx, args);
      const matcher = buildMatcher(args.query, { match: args.match, regex: args.regex });
      const groupBy = args.group_by ?? (args.source === "outbound" ? ["agent_name"] : ["category"]);
      const counter = new GroupCounter(groupBy);
      const results: Row[] = [];
      let searched = 0;
      for (const row of calls.rows) {
        if (typeof row.transcript !== "string" || row.transcript.trim() === "") continue;
        searched += 1;
        const parts = searchable(row.transcript, args.speaker, calls.speakers);
        if (!matcher.matches(parts.map((p) => p.text))) continue;
        counter.add(row);
        if (results.length < args.max_results) {
          const extra = args.source === "outbound" ? {} : { firstUserLine: row.firstUserLine };
          results.push({ ...calls.meta(row), ...extra, snippets: snippets(parts, matcher, args.snippet_chars, args.snippets_per_call), heading: calls.heading(row) });
        }
      }
      const groups = counter.groups();
      const notes = joinNotes(calls.stats);
      const warnings = columnWarnings(calls.scan, { where: args.where, groupBy });
      const lines = [
        `${counter.total} of ${searched} call(s) with a transcript match ${args.regex ? `/${args.query}/` : `"${args.query}"`} (${args.match}, speaker ${args.speaker}).`,
        counter.total > 0 ? `By ${counter.fields.join(", ")}:\n${groups.slice(0, 30).map((g) => `- ${g.values.join(" / ")}: ${g.count}`).join("\n")}` : "",
        ...results.map((r) => `${r.heading}\n${(r.snippets as string[]).map((s) => `  > ${s}`).join("\n")}`),
        counter.total > results.length ? `Listed ${results.length} of ${counter.total} matches; raise max_results or narrow with where.` : "",
        ...warnings.map((w) => `Warning: ${w}`),
        footer({
          tenant: calls.client.tenant,
          label: calls.label,
          start: args.start,
          end: args.end,
          returned: results.length,
          totalRecords: calls.totalRecords,
          hasMore: calls.hasMore,
          scanned: calls.scanned,
          filtered: true,
          apiCalls: calls.apiCalls,
          notes,
        }),
      ];
      return textResult(lines.filter(Boolean).join("\n\n"), {
        tenant: calls.client.tenant,
        source: args.source,
        query: args.query,
        matched: counter.total,
        searched,
        groupBy: counter.fields,
        groups,
        results: results.map(({ heading: _h, ...r }) => r),
        transcripts: calls.stats,
        notes,
        warnings,
        totalRecords: calls.totalRecords,
        apiCalls: calls.apiCalls,
      });
    }),
  );

  server.registerTool(
    "netic_get_call_transcripts",
    {
      title: "Read Netic call transcripts",
      description:
        "Return whole call transcripts with each call's outcome columns, in batches sized to fit the context, for reading or classifying calls. Pick calls by ids (interaction id or ServiceTitan call id, e.g. from netic_search_call_transcripts), or by where plus sample. " +
        "To classify many calls, go batch by batch: pass the returned next_offset as offset until it is null, and tally as you go; do not ask for everything at once. Long transcripts keep their start and end with […] between. " +
        "source=inbound (default): calls to the Netic AI agent, Agent/User turns, from the dashboard's Calls Drill Down CSV until Netic adds them to the API: " +
        EXPORT_HOWTO +
        " source=outbound: human CSR calls from ServiceTitan, CXR (the CSR) and Customer turns, straight from the API, with the qa_* scorecard columns beside each call. " +
        "Dates are YYYY-MM-DD, both inclusive, tenant local time. Transcripts contain customer names, phones, and addresses.",
      inputSchema: {
        tenant: tenantArg(ctx),
        start: startArg,
        end: endArg,
        source: sourceArg,
        ids: z.array(z.string().min(1)).min(1).max(200).optional().describe("Call ids or ServiceTitan call ids to return. Other filters still apply."),
        where: whereArg,
        agent_ids: agentIdsArg.describe("source=outbound only: restrict to these ServiceTitan agent (CSR) ids."),
        sample: z.enum(["first", "random"]).default("first").describe("first (default): oldest first. random: a seeded shuffle, so offset pages through the same order."),
        seed: z.number().int().default(1).describe("Seed for sample=random. Default 1; keep it fixed while paging."),
        offset: z.number().int().min(0).default(0).describe("Skip this many selected calls; pass next_offset from the last batch."),
        limit: z.number().int().min(1).max(200).default(25).describe("Most calls per batch. Default 25."),
        max_chars_per_call: z.number().int().min(200).max(20_000).default(4000).describe("Truncate each transcript to about this many characters. Default 4000 (the median inbound call is under 1000)."),
        max_total_chars: z.number().int().min(1000).max(200_000).default(60_000).describe("Stop the batch before transcripts pass this many characters. Default 60000."),
        csv_path: csvPathArg.describe("source=inbound only. " + (csvPathArg.description ?? "")),
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      const calls = await collectCalls(ctx, args);
      let selected = calls.rows.filter((r) => typeof r.transcript === "string" && r.transcript.trim() !== "");
      if (args.ids) {
        const wanted = new Set(args.ids.map((s) => s.trim()));
        selected = selected.filter((r) => calls.idOf(r).some((id) => wanted.has(id)));
      }
      if (args.sample === "random") selected = seededShuffle(selected, args.seed);
      const batch: Row[] = [];
      const headings: string[] = [];
      let chars = 0;
      let i = args.offset;
      for (; i < selected.length && batch.length < args.limit; i += 1) {
        const row = selected[i]!;
        const t = truncate(row.transcript as string, args.max_chars_per_call);
        if (batch.length > 0 && chars + t.text.length > args.max_total_chars) break;
        chars += t.text.length;
        batch.push({ ...calls.meta(row), transcriptChars: row.transcriptChars ?? (row.transcript as string).length, truncated: t.truncated, transcript: t.text });
        headings.push(calls.heading(row));
      }
      const nextOffset = i < selected.length ? i : null;
      const notes = joinNotes(calls.stats);
      const warnings = columnWarnings(calls.scan, { where: args.where });
      if (args.ids && selected.length < args.ids.length) {
        warnings.push(`${args.ids.length - selected.length} of the ${args.ids.length} ids matched no ${args.source} call with a transcript in ${args.start} to ${args.end}.`);
      }
      const text = [
        `Calls ${args.offset + 1} to ${args.offset + batch.length} of ${selected.length} selected (${chars} transcript characters).${nextOffset !== null ? ` Next batch: offset=${nextOffset}.` : " That is the last batch."}`,
        ...batch.map((r, n) => `### ${headings[n]}\n${r.transcript}`),
        ...warnings.map((w) => `Warning: ${w}`),
        footer({
          tenant: calls.client.tenant,
          label: calls.label,
          start: args.start,
          end: args.end,
          returned: batch.length,
          totalRecords: calls.totalRecords,
          hasMore: nextOffset !== null || calls.hasMore,
          scanned: calls.scanned,
          filtered: true,
          apiCalls: calls.apiCalls,
          moreHint: nextOffset !== null ? `Call again with offset=${nextOffset}.` : undefined,
          notes,
        }),
      ].join("\n\n");
      return textResult(text, {
        tenant: calls.client.tenant,
        source: args.source,
        selected: selected.length,
        offset: args.offset,
        returned: batch.length,
        next_offset: nextOffset,
        transcriptCharacters: chars,
        calls: batch,
        transcripts: calls.stats,
        notes,
        warnings,
        totalRecords: calls.totalRecords,
        apiCalls: calls.apiCalls,
      });
    }),
  );
}
