import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NeticRequestError, type NeticClient, type Row } from "../client.js";
import type { AppContext } from "../context.js";
import { addDays, rangeViolation } from "../dates.js";
import { MODALITIES } from "../endpoints.js";
import { footer, markdownTable, textResult } from "../format.js";
import {
  LEAD_DEFAULT_COLUMNS,
  annotateContacts,
  annotateRepeats,
  isLead,
  markRecovered,
  phoneKey,
  summarize,
  toContact,
  toLead,
  type Contact,
  type LeadSummary,
} from "../leads.js";
import { walkRange } from "../paging.js";
import { project, wherePredicate, type Where } from "../rows.js";
import { READ_ONLY, endArg, fieldsArg, guarded, reportParams, startArg, tenantArg, whereArg } from "./common.js";

export const LEADS_REPORT = "scheduler_leads";
export const LEADS_LABEL = "online scheduler leads";

export const checkContactsArg = z
  .boolean()
  .default(true)
  .describe(
    "Look up each abandoned lead's phone in Netic inbound calls, texts, and recapture texts after the session (contacted_later, and recovered when that contact got a job). Default true; false skips those three pulls and bases recovered on online rebooking only.",
  );
export const repeatWindowArg = z
  .number()
  .int()
  .min(0)
  .max(30)
  .default(7)
  .describe(
    "Follow-up window in days. booked_later and contacted_later count only within this many days after each session, and the fetch reaches this far before start and after end so repeats and follow-ups at the edges are seen. Default 7. Only sessions inside start..end are returned.",
  );

export interface LeadArgs {
  start: string;
  end: string;
  booked?: "yes" | "no" | "all" | undefined;
  exclude_recovered?: boolean | undefined;
  check_contacts?: boolean | undefined;
  repeat_window_days?: number | undefined;
  where?: Where | undefined;
}

export interface LeadCollection {
  rows: Row[];
  /** Sessions the API returned across the look window. */
  scanned: number;
  totalRecords: number;
  fetchStart: string;
  fetchEnd: string;
  contactsChecked: number | undefined;
  apiCalls: number;
  notes: string[];
  followUp: FollowUpInfo;
}

/**
 * What the follow-up flags covered, for structuredContent: Claude's client
 * shows the model only that, so the footer notes alone would never reach it.
 */
export interface FollowUpInfo {
  /** False when check_contacts=false: contacted_later is blank and recovered means booked online later only. */
  contactsChecked: boolean;
  interactionsChecked: number | null;
  windowDays: number;
  /** True while some leads' follow-up windows reach past today, so flags can still change. */
  windowStillOpen: boolean;
  windowEnds: string;
  sessionsFetched: { start: string; end: string };
  /** One line for the agent to relay when the caveats matter. */
  caveat: string;
}

/** Today's date on this machine, which runs in the tenants' part of the world. */
function localToday(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Build the lead rows for start..end: every scheduler session in the widened
 * look window, the inclusion rule, repeat and follow-up flags, then the
 * clip to start..end and the caller's filters, in that order.
 */
export async function collectLeads(client: NeticClient, args: LeadArgs): Promise<LeadCollection> {
  const problem = rangeViolation(args.start, args.end);
  if (problem) throw new NeticRequestError(problem);
  const windowDays = args.repeat_window_days ?? 7;
  const today = localToday();
  const fetchStart = addDays(args.start, -windowDays);
  const wantedEnd = addDays(args.end, windowDays);
  const fetchEnd = wantedEnd < today ? wantedEnd : today < args.end ? args.end : today;
  const before = client.requestCount;

  const sessionsWalk = walkRange(client, "scheduler_sessions", reportParams("scheduler_sessions", { start: fetchStart, end: fetchEnd }), fetchStart, fetchEnd, {
    pageSize: 5000,
    maxRows: Infinity,
  });
  const checkContacts = args.check_contacts ?? true;
  const contacts: Contact[] = [];
  const contactWalks = checkContacts
    ? MODALITIES.map((modality) =>
        walkRange(client, "interactions", reportParams("interactions", { start: args.start, end: fetchEnd, modality }), args.start, fetchEnd, {
          pageSize: 5000,
          maxRows: Infinity,
          onRows: (rows) => {
            for (const r of rows) {
              const c = toContact(r, modality);
              if (c) contacts.push(c);
            }
          },
        }),
      )
    : [];
  const [sessions] = await Promise.all([sessionsWalk, ...contactWalks]);

  const all = sessions.rows.filter(isLead).map((s) => toLead(s, client.tenant));
  const inRange = all.filter((l) => {
    const day = l.at.slice(0, 10);
    return day >= args.start && day <= args.end;
  });
  annotateRepeats(inRange, all, windowDays);
  if (checkContacts) {
    const phones = new Set(inRange.filter((l) => !l.booked).map((l) => phoneKey(l.row["Phone Number"])));
    annotateContacts(
      inRange,
      contacts.filter((c) => phones.has(c.phone)),
      windowDays,
    );
  }
  markRecovered(inRange);

  const booked = args.booked ?? "all";
  const user = wherePredicate(args.where);
  const rows = inRange
    .filter((l) => booked === "all" || (booked === "yes") === l.booked)
    .filter((l) => !args.exclude_recovered || l.row.recovered !== "Yes")
    .map((l) => l.row)
    .filter((r) => !user || user(r));

  const notes = [`sessions fetched ${fetchStart} to ${fetchEnd} for repeat checks; leads kept from ${args.start} to ${args.end}; follow-ups count within ${windowDays} day(s) of each session`];
  if (checkContacts) notes.push(`${contacts.length} inbound interaction(s) from ${args.start} to ${fetchEnd} checked for follow-up contact`);
  else notes.push("contact check skipped (check_contacts=false): recovered means booked online later only");
  const windowStillOpen = wantedEnd >= today;
  if (windowStillOpen) notes.push(`the follow-up window runs to ${wantedEnd}, past today, so later rebookings and contacts can still appear`);
  const caveats = [
    checkContacts
      ? `recovered counts online rebookings and Netic inbound calls or texts from the same phone within ${windowDays} day(s) of the session; calls to other numbers, outbound calls, and address-only leads' calls are not seen`
      : "contacts were not checked (check_contacts=false), so recovered means booked online again only; people who called in and booked still show as bounced",
  ];
  if (windowStillOpen) caveats.push(`the ${windowDays}-day follow-up window is still open until ${wantedEnd}, so these flags can still change`);
  return {
    rows,
    scanned: sessions.scanned,
    totalRecords: sessions.totalRecords,
    fetchStart,
    fetchEnd,
    contactsChecked: checkContacts ? contacts.length : undefined,
    apiCalls: client.requestCount - before,
    notes,
    followUp: {
      contactsChecked: checkContacts,
      interactionsChecked: checkContacts ? contacts.length : null,
      windowDays,
      windowStillOpen,
      windowEnds: wantedEnd,
      sessionsFetched: { start: fetchStart, end: fetchEnd },
      caveat: `${caveats.join("; ")}.`,
    },
  };
}

function summaryMarkdown(s: LeadSummary): string {
  const lines = [
    `**${s.leads} lead(s)**: ${s.booked} booked, ${s.abandoned} abandoned, of which ${s.recovered} recovered (booked later or got a job through Netic) and ${s.stillBounced} still bounced.`,
  ];
  if (s.abandoned > 0) {
    const labels: Record<string, string> = {
      furthestStage: "Furthest stage",
      service: "Service",
      marketingSource: "Marketing source",
      utmSource: "UTM source",
      bookedFrom: "Booked from",
      blockerType: "Blocker",
    };
    lines.push("Abandoned leads by:");
    for (const [key, counts] of Object.entries(s.abandonedBy)) {
      lines.push(`- ${labels[key] ?? key}: ${counts.map((c) => `${c.value} ${c.count}`).join(", ")}`);
    }
  }
  return lines.join("\n");
}

export function registerLeadTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "netic_get_scheduler_leads",
    {
      title: "Get Netic online scheduler leads",
      description:
        "The Netic dashboard's \"online scheduler leads\" export: one row per online scheduler session where the customer gave a phone number or street address, booked or not (anonymous and name-only sessions are left out). " +
        "Columns match the export (Tenant, Date MM/dd/yyyy HH:mm, Name, Identified By, Phone Number, address, Booked, Furthest Stage Reached like \"Schedule (stage 4 of 6)\", Service, UTM Source/Medium/Campaign; Last Known Step is not available from the API), then session fields (blocker_type, booked_from, marketing_source, device_type, issue_description, customer_id, ...), then bounce follow-up flags: attempt and sessions_for_person (repeat visits by phone, else address), booked_later (a later completed session), contacted_later (the first Netic inbound call or text from that phone afterwards, with its category and job id), and recovered (booked later, or that contact got a job or category Booked). " +
        "Also returns a summary: booked, abandoned, recovered, still bounced, and abandoned leads by furthest stage, Service, marketing source, UTM source, booked_from, and blocker. " +
        "The contact check runs by default (check_contacts=true, three extra pulls); the result's followUp block says whether it ran, the window used, whether that window is still open, and a caveat line. Mention the caveat when presenting recovered or still-bounced numbers, when the window is still open, or when the user asks how recovery is determined. " +
        "For a daily digest of who bounced and still needs a call: booked=no, exclude_recovered=true, start=end=yesterday. For counts by any column use netic_count with report=scheduler_leads; for the full file use netic_export with report=scheduler_leads. " +
        "Dates are YYYY-MM-DD, both inclusive, tenant local time.",
      inputSchema: {
        tenant: tenantArg(ctx),
        start: startArg,
        end: endArg,
        booked: z
          .enum(["all", "no", "yes"])
          .default("all")
          .describe("all (default, like the export), no (abandoned: bounced), or yes (booked)."),
        exclude_recovered: z
          .boolean()
          .default(false)
          .describe("Drop abandoned leads that later booked online or got a job through Netic, leaving the ones that still need follow-up. Default false."),
        check_contacts: checkContactsArg,
        repeat_window_days: repeatWindowArg,
        fields: fieldsArg,
        where: whereArg.describe(
          'Client-side equality filter on the lead columns (export names or session fields), case-insensitive, e.g. {"Service":"AC Repair","UTM Source":["google",""]}. An array matches any value; "" matches blank.',
        ),
        max_rows: z.number().int().min(1).max(5000).default(500).describe("Rows to return inline. Default 500; the summary always covers every matching lead."),
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      const client = ctx.clientFor(args.tenant);
      const c = await collectLeads(client, args);
      const summary = summarize(c.rows);
      const shown = c.rows.slice(0, args.max_rows);
      const available = c.rows.length > 0 ? Object.keys(c.rows[0]!) : [];
      const columns = args.fields ?? LEAD_DEFAULT_COLUMNS;
      const lines = [
        `${LEADS_LABEL} for tenant ${client.tenant}${args.booked !== "all" ? ` (booked=${args.booked})` : ""}${args.exclude_recovered ? ", recovered leads excluded" : ""}.`,
        summaryMarkdown(summary),
        markdownTable(shown, columns),
      ];
      if (!args.fields && shown.length > 0) {
        lines.push(`Showing ${columns.length} of ${available.length} columns. All columns: ${available.join(", ")}. Pass fields to choose.`);
      }
      const hasMore = c.rows.length > shown.length;
      lines.push(
        footer({
          tenant: client.tenant,
          label: LEADS_LABEL,
          start: args.start,
          end: args.end,
          returned: shown.length,
          totalRecords: c.totalRecords,
          hasMore,
          scanned: c.scanned,
          filtered: true,
          apiCalls: c.apiCalls,
          moreHint: `${c.rows.length} leads match; raise max_rows, or use netic_export with report=${LEADS_REPORT}.`,
          notes: c.notes,
        }),
      );
      return textResult(lines.join("\n\n"), {
        tenant: client.tenant,
        report: LEADS_REPORT,
        start: args.start,
        end: args.end,
        fetchStart: c.fetchStart,
        fetchEnd: c.fetchEnd,
        summary,
        matched: c.rows.length,
        returned: shown.length,
        hasMore,
        sessionsScanned: c.scanned,
        followUp: c.followUp,
        columns,
        rows: shown.map((r) => project(r, columns)),
        apiCalls: c.apiCalls,
      });
    }),
  );
}
