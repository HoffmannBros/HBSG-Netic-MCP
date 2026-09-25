import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { NeticRequestError, type QueryParams } from "../client.js";
import { expandPathTokens } from "../config.js";
import type { AppContext } from "../context.js";
import { MODALITIES, REPORT_INFO, REPORTS, type Modality, type Report } from "../endpoints.js";
import { errorResult } from "../format.js";

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/** Friendly names for the known slugs. Anything else shows its slug. */
export const TENANT_LABELS: Record<string, string> = {
  stl: "Hoffmann STL",
  nash: "Hoffmann NSH",
  blue: "Blue Sky",
  ferg: "Ferguson STL",
};

export function tenantArg(ctx: AppContext) {
  const names = ctx.tenantNames();
  const known = names.length > 0 ? `Configured: ${names.map((n) => (TENANT_LABELS[n] ? `${n} (${TENANT_LABELS[n]})` : n)).join(", ")}.` : "No tenants are configured yet.";
  return z
    .string()
    .min(1)
    .describe(`Netic tenant name. Required; there is no default. Ask the user which brand if they did not say. ${known}`);
}

export const startArg = z
  .string()
  .describe("Start date, YYYY-MM-DD, inclusive, tenant local time (createdOnOrAfter; startDate on utilization).");
export const endArg = z
  .string()
  .describe(
    "End date, YYYY-MM-DD, INCLUSIVE, tenant local time (createdBefore, which despite the name includes the day; endDate on utilization). For one day, end = start.",
  );

export const snapshotDateArg = z
  .string()
  .optional()
  .describe(
    "Utilization only. Point in time, as in the Utilization Board: rebuild the board as it stood at this moment (YYYY-MM-DD, tenant local, not in the future). Jobs, shifts, and bookings created, cancelled, or edited afterwards are left out. Alone it means the end of that day (the board's \"Use end of day\"). Omit for Live.",
  );
export const snapshotTimeArg = z
  .string()
  .optional()
  .describe("Utilization only. Time of the snapshot, HH:mm 24-hour, tenant local (MDT for Blue Sky, CDT for the others). Needs snapshot_date.");

export const modalityArg = z
  .enum(MODALITIES)
  .describe("call (inbound calls to the AI agent), inbound_text (inbound SMS), or recapture_text (texts that recapture missed calls).");

export const reportArg = z
  .enum(REPORTS)
  .describe(
    "interactions (needs modality), scheduler_sessions, scheduler_bookings, tgl_bookings, referrer_bookings, outbound_calls, or utilization (Utilization Board: % booked per business unit or group per day).",
  );

export const fieldsArg = z
  .array(z.string().min(1))
  .min(1)
  .optional()
  .describe("Columns to return, in order. Omit for a sensible default set; the result lists every available column.");

export const whereArg = z
  .record(z.string(), z.union([z.string(), z.array(z.string())]))
  .optional()
  .describe(
    'Client-side equality filter by column, case-insensitive. An array matches any value; "" matches blank. Columns combine with AND, e.g. {"category":"Booked","trade":["HVAC","Plumbing"]}.',
  );

export const agentIdsArg = z
  .array(z.union([z.string().regex(/^\d+$/), z.number().int().positive()]))
  .optional()
  .describe("Outbound calls only: restrict to these ServiceTitan agent (CSR) ids.");

export const outputDirArg = z
  .string()
  .optional()
  .describe("Folder to write into. Defaults to the configured export folder. Supports ${HOME}, ${DOCUMENTS}, ${DESKTOP}, ${DOWNLOADS}.");

export const filenameArg = z
  .string()
  .optional()
  .describe("File name (extension optional). Defaults to a descriptive name. Existing files are never overwritten; a numeric suffix is added.");

export interface ReportArgs {
  start: string;
  end: string;
  modality?: Modality | undefined;
  agent_ids?: Array<string | number> | undefined;
  snapshot_date?: string | undefined;
  snapshot_time?: string | undefined;
}

/** Query parameters for a report, in the API's own names. */
export function reportParams(report: Report, args: ReportArgs): QueryParams {
  const names = REPORT_INFO[report].dateParams;
  const params: QueryParams = { [names.start]: args.start, [names.end]: args.end };
  if (report === "interactions") {
    if (!args.modality) throw new NeticRequestError(`modality is required for interactions: ${MODALITIES.join(", ")}.`);
    params.modality = args.modality;
  }
  if (report === "outbound_calls" && args.agent_ids && args.agent_ids.length > 0) {
    params.agentId = args.agent_ids.map(String).join(",");
  }
  if (report === "utilization") {
    if (args.snapshot_date) params.snapshotDate = args.snapshot_date;
    if (args.snapshot_time) params.snapshotTime = args.snapshot_time;
  } else if (args.snapshot_date || args.snapshot_time) {
    throw new NeticRequestError("snapshot_date and snapshot_time apply only to the utilization report.");
  }
  return params;
}

export function resolveOutputDir(ctx: AppContext, override?: string): string {
  return override && override.trim() ? expandPathTokens(override) : ctx.config.outputDir;
}

export function withExtension(name: string, ext: string): string {
  return name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`;
}

/** Wrap a handler so thrown errors become isError results with useful text. */
export function guarded<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return errorResult(err);
    }
  };
}
