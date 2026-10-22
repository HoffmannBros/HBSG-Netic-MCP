import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GroupCounter } from "../aggregate.js";
import type { NeticClient, Row } from "../client.js";
import { expandPathTokens } from "../config.js";
import type { AppContext } from "../context.js";
import { footer, textResult } from "../format.js";
import { neticTenantName } from "../leads.js";
import { walkRange } from "../paging.js";
import { project, wherePredicate, type Where } from "../rows.js";
import {
  EXPORT_HOWTO,
  TranscriptSourceError,
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
} from "../transcripts.js";
import { READ_ONLY, endArg, guarded, startArg, tenantArg, whereArg } from "./common.js";

const LABEL = "inbound AI call transcripts";

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

export const csvPathArg = z
  .string()
  .optional()
  .describe(
    "Path to a Calls Drill Down CSV from the Netic dashboard. Omit to use the newest drilldown_export*.csv for this tenant in the transcript folder (default Downloads). Supports ${HOME}, ${DOWNLOADS}, and the like.",
  );

export interface CallsWithTranscripts {
  client: NeticClient;
  rows: Row[];
  stats: JoinStats;
  totalRecords: number;
  scanned: number;
  hasMore: boolean;
  apiCalls: number;
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

/** Every inbound call in the range (optionally filtered), with transcripts attached. */
async function collectCalls(ctx: AppContext, args: { tenant: string; start: string; end: string; where?: Where | undefined; csv_path?: string | undefined }): Promise<CallsWithTranscripts> {
  const client = ctx.clientFor(args.tenant);
  const before = client.requestCount;
  const walked = await walkRange(client, "interactions", { modality: "call", createdOnOrAfter: args.start, createdBefore: args.end }, args.start, args.end, {
    pageSize: 5000,
    maxRows: 1_000_000,
    filter: wherePredicate(args.where),
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
  };
}

function callMeta(row: Row): Row {
  return project(row, [...CALL_COLUMNS]);
}

export function registerTranscriptTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "netic_search_call_transcripts",
    {
      title: "Search Netic inbound call transcripts",
      description:
        "Search what callers and the Netic AI agent said on inbound calls, and count the matching calls by any interaction column. Returns the number of matching calls, grouped counts over every match, and up to max_results calls with their outcome columns and short snippets around each hit. Use it for \"how many calls mention X, by outcome\" and for finding examples; follow up with netic_get_call_transcripts (by id) to read whole calls. " +
        "Transcripts come from the dashboard's Calls Drill Down CSV until Netic adds them to the API: " +
        EXPORT_HOWTO +
        " The footer says which file was used, what dates it covers, and how many calls had no transcript. Dates are YYYY-MM-DD, both inclusive, tenant local time. Transcripts contain customer names, phones, and addresses.",
      inputSchema: {
        tenant: tenantArg(ctx),
        start: startArg,
        end: endArg,
        query: z
          .string()
          .min(1)
          .describe('Words to find, case-insensitive; quote a phrase to keep it together, e.g. membership "tune up". With regex=true, one JavaScript regular expression.'),
        match: z.enum(["any", "all"]).default("any").describe("any (default): a call matches if it has any term. all: it must have every term (anywhere in the call)."),
        regex: z.boolean().default(false).describe("Treat query as a regular expression (case-insensitive)."),
        speaker: z.enum(["any", "agent", "user"]).default("any").describe("Search only what the caller said (user), only the AI agent (agent), or both (any, default)."),
        where: whereArg,
        group_by: z.array(z.string().min(1)).min(1).max(3).optional().describe('Interaction columns to count matches by, e.g. ["category"] or ["reason","subReason"].'),
        max_results: z.number().int().min(0).max(500).default(50).describe("Matching calls to list, oldest first. Default 50; counts always cover every match."),
        snippets_per_call: z.number().int().min(1).max(5).default(2).describe("Snippets per call. Default 2."),
        snippet_chars: z.number().int().min(40).max(600).default(160).describe("Approximate snippet width in characters. Default 160."),
        csv_path: csvPathArg,
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      const calls = await collectCalls(ctx, args);
      const matcher = buildMatcher(args.query, { match: args.match, regex: args.regex });
      const counter = new GroupCounter(args.group_by ?? ["category"]);
      const results: Row[] = [];
      let searched = 0;
      for (const row of calls.rows) {
        if (typeof row.transcript !== "string") continue;
        searched += 1;
        const parts = searchable(row.transcript, args.speaker);
        if (!matcher.matches(parts.map((p) => p.text))) continue;
        counter.add(row);
        if (results.length < args.max_results) {
          results.push({ ...callMeta(row), firstUserLine: row.firstUserLine, snippets: snippets(parts, matcher, args.snippet_chars, args.snippets_per_call) });
        }
      }
      const groups = counter.groups();
      const notes = joinNotes(calls.stats);
      const lines = [
        `${counter.total} of ${searched} call(s) with a transcript match ${args.regex ? `/${args.query}/` : `"${args.query}"`} (${args.match}, speaker ${args.speaker}).`,
        counter.total > 0 ? `By ${counter.fields.join(", ")}:\n${groups.slice(0, 30).map((g) => `- ${g.values.join(" / ")}: ${g.count}`).join("\n")}` : "",
        ...results.map((r) => `${r.date} · ${r.category} · ${r.reason} / ${r.subReason} · id ${r.id}\n${(r.snippets as string[]).map((s) => `  > ${s}`).join("\n")}`),
        counter.total > results.length ? `Listed ${results.length} of ${counter.total} matches; raise max_results or narrow with where.` : "",
        footer({
          tenant: calls.client.tenant,
          label: LABEL,
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
        query: args.query,
        matched: counter.total,
        searched,
        groupBy: counter.fields,
        groups,
        results,
        transcripts: calls.stats,
        notes,
        totalRecords: calls.totalRecords,
        apiCalls: calls.apiCalls,
      });
    }),
  );

  server.registerTool(
    "netic_get_call_transcripts",
    {
      title: "Read Netic inbound call transcripts",
      description:
        "Return whole inbound call transcripts (Agent/User turns) with each call's outcome columns, in batches sized to fit the context, for reading or classifying calls. Pick calls by ids (interaction id or ServiceTitan call id, e.g. from netic_search_call_transcripts), or by where plus sample. " +
        "To classify many calls, go batch by batch: pass the returned next_offset as offset until it is null, and tally as you go; do not ask for everything at once. Long transcripts keep their start and end with […] between. " +
        "Transcripts come from the dashboard's Calls Drill Down CSV until Netic adds them to the API: " +
        EXPORT_HOWTO +
        " Dates are YYYY-MM-DD, both inclusive, tenant local time. Transcripts contain customer names, phones, and addresses.",
      inputSchema: {
        tenant: tenantArg(ctx),
        start: startArg,
        end: endArg,
        ids: z.array(z.string().min(1)).min(1).max(200).optional().describe("Interaction ids or ServiceTitan call ids to return. Other filters still apply."),
        where: whereArg,
        sample: z.enum(["first", "random"]).default("first").describe("first (default): oldest first. random: a seeded shuffle, so offset pages through the same order."),
        seed: z.number().int().default(1).describe("Seed for sample=random. Default 1; keep it fixed while paging."),
        offset: z.number().int().min(0).default(0).describe("Skip this many selected calls; pass next_offset from the last batch."),
        limit: z.number().int().min(1).max(200).default(25).describe("Most calls per batch. Default 25."),
        max_chars_per_call: z.number().int().min(200).max(20_000).default(4000).describe("Truncate each transcript to about this many characters. Default 4000 (the median call is under 1000)."),
        max_total_chars: z.number().int().min(1000).max(200_000).default(60_000).describe("Stop the batch before transcripts pass this many characters. Default 60000."),
        csv_path: csvPathArg,
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      const calls = await collectCalls(ctx, args);
      let selected = calls.rows.filter((r) => typeof r.transcript === "string");
      if (args.ids) {
        const wanted = new Set(args.ids.map((s) => s.trim()));
        selected = selected.filter((r) => wanted.has(String(r.id ?? "")) || wanted.has(String(r.serviceTitanCallId ?? "")));
      }
      if (args.sample === "random") selected = seededShuffle(selected, args.seed);
      const batch: Row[] = [];
      let chars = 0;
      let i = args.offset;
      for (; i < selected.length && batch.length < args.limit; i += 1) {
        const row = selected[i]!;
        const t = truncate(row.transcript as string, args.max_chars_per_call);
        if (batch.length > 0 && chars + t.text.length > args.max_total_chars) break;
        chars += t.text.length;
        batch.push({ ...callMeta(row), transcriptChars: row.transcriptChars, truncated: t.truncated, transcript: t.text });
      }
      const nextOffset = i < selected.length ? i : null;
      const notes = joinNotes(calls.stats);
      const text = [
        `Calls ${args.offset + 1} to ${args.offset + batch.length} of ${selected.length} selected (${chars} transcript characters).${nextOffset !== null ? ` Next batch: offset=${nextOffset}.` : " That is the last batch."}`,
        ...batch.map((r) => `### ${r.date} · ${r.category} · ${r.reason} / ${r.subReason} · id ${r.id}\n${r.transcript}`),
        footer({
          tenant: calls.client.tenant,
          label: LABEL,
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
        selected: selected.length,
        offset: args.offset,
        returned: batch.length,
        next_offset: nextOffset,
        transcriptCharacters: chars,
        calls: batch,
        transcripts: calls.stats,
        notes,
        totalRecords: calls.totalRecords,
        apiCalls: calls.apiCalls,
      });
    }),
  );
}
