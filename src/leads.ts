import type { Row } from "./client.js";
import { addDays } from "./dates.js";

/**
 * The dashboard's "online scheduler leads" export, rebuilt from
 * scheduler/sessions: one row per session where the customer gave a phone or
 * a street address, booked or not. Verified 807 of 807 rows against the
 * export on 2026-09-30 (docs/netic-api.md). Pure functions only; the fetching
 * lives in src/tools/leads.ts.
 */

/** Row `tenant` values Netic uses on other endpoints; sessions carry none. */
export const NETIC_TENANT_NAMES: Record<string, string> = {
  stl: "STL Hoffmann",
  nash: "NASH Hoffmann",
  blue: "Blue Sky",
  ferg: "Ferguson",
};

export function neticTenantName(slug: string): string {
  return NETIC_TENANT_NAMES[slug] ?? slug;
}

/** The export's columns, in its order. Last Known Step is not in the public API. */
export const EXPORT_COLUMNS = [
  "Tenant",
  "Date",
  "Name",
  "Identified By",
  "Phone Number",
  "Street Address",
  "City",
  "State",
  "Zip Code",
  "Booked",
  "Furthest Stage Reached",
  "Service",
  "UTM Source",
  "UTM Medium",
  "UTM Campaign",
] as const;

/** Session fields copied as-is after the export columns. */
const EXTRA_FIELDS = [
  "last_step",
  "blocker_type",
  "blocker_detail",
  "booked_from",
  "marketing_source",
  "device_type",
  "trade",
  "work_type",
  "issue_description",
  "job_details",
  "landing_page_url",
  "referrer_url",
  "customer_email",
  "customer_type",
  "customer_is_new",
  "customer_id",
  "booked_job_id",
  "appointment_start",
] as const;

/** Repeat and follow-up columns. Follow-ups are blank on booked rows. */
export const FOLLOW_UP_COLUMNS = [
  "person_key",
  "sessions_for_person",
  "attempt",
  "booked_later",
  "booked_later_at",
  "booked_later_job_id",
  "contacted_later",
  "contacted_later_at",
  "contacted_later_via",
  "contacted_later_category",
  "contacted_later_job_id",
  "recovered",
] as const;

export const LEAD_COLUMNS: string[] = [...EXPORT_COLUMNS, "stage_number", ...EXTRA_FIELDS, "session_id", ...FOLLOW_UP_COLUMNS];

/** Columns shown inline when the caller names none: no addresses or free text. */
export const LEAD_DEFAULT_COLUMNS = [
  "Date",
  "Name",
  "Phone Number",
  "Booked",
  "Furthest Stage Reached",
  "Service",
  "UTM Source",
  "marketing_source",
  "blocker_type",
  "attempt",
  "booked_later",
  "contacted_later",
  "contacted_later_category",
  "recovered",
];

/** Scheduler steps in order; the export shows "Customer (stage 3 of 6)". `location` comes before them and never carries PII. */
export const STAGES: Record<string, number> = { issue: 1, details: 2, customer: 3, schedule: 4, confirmation: 5, booked: 6 };
const STAGE_COUNT = 6;

const text = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());
/** Copied values keep Netic's own whitespace, as the export does (trailing spaces in City were seen). */
const raw = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const capitalize = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export function stageNumber(lastStep: unknown): number | undefined {
  return STAGES[text(lastStep).toLowerCase()];
}

export function stageLabel(lastStep: unknown): string {
  const step = text(lastStep);
  const n = stageNumber(step);
  return n === undefined ? capitalize(step) : `${capitalize(step.toLowerCase())} (stage ${n} of ${STAGE_COUNT})`;
}

/** The export's inclusion rule: a phone number or a street address. A name alone is not enough. */
export function isLead(session: Row): boolean {
  return text(session.customer_phone_number) !== "" || text(session.street_address) !== "";
}

export function isBookedSession(session: Row): boolean {
  return text(session.status).toLowerCase() === "completed";
}

/** Last 10 digits, so 952-250-7473, (952) 250-7473, and +19522507473 are one number. Undefined under 10 digits. */
export function phoneKey(phone: unknown): string | undefined {
  const digits = text(phone).replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : undefined;
}

/** Phone when there is one, else street address plus 5-digit zip, lowercased with punctuation collapsed. */
export function personKey(session: Row): string | undefined {
  const phone = phoneKey(session.customer_phone_number);
  if (phone) return `phone:${phone}`;
  const street = text(session.street_address).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!street) return undefined;
  const zip = text(session.zip_code).replace(/\D/g, "").slice(0, 5);
  return `address:${street}${zip ? ` ${zip}` : ""}`;
}

/**
 * A comparable local timestamp, "YYYY-MM-DD HH:mm". Sessions use
 * "YYYY-MM-DD HH:mm:ss" and interactions "MM/dd/yyyy HH:mm", both tenant
 * local, so no timezone math is needed.
 */
export function localStamp(value: unknown): string {
  const v = text(value);
  const us = /^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2})/.exec(v);
  if (us) return `${us[3]}-${us[1]}-${us[2]} ${us[4]}:${us[5]}`;
  const iso = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(v);
  if (iso) return `${iso[1]} ${iso[2]}:${iso[3]}`;
  return v;
}

/** "YYYY-MM-DD HH:mm:ss" to the export's "MM/dd/yyyy HH:mm". */
export function exportDate(value: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(text(value));
  return m ? `${m[2]}/${m[3]}/${m[1]} ${m[4]}:${m[5]}` : text(value);
}

/** One lead row: the export's columns, then the session's analysis fields. Follow-up columns start blank. */
export function toLeadRow(session: Row, tenantSlug: string): Row {
  const phone = raw(session.customer_phone_number);
  const row: Row = {
    Tenant: neticTenantName(tenantSlug),
    Date: exportDate(session.session_created_at),
    Name: raw(session.customer_name),
    "Identified By": phone.trim() ? "Phone" : "Address",
    "Phone Number": phone,
    "Street Address": raw(session.street_address),
    City: raw(session.city),
    State: raw(session.state),
    "Zip Code": raw(session.zip_code),
    Booked: isBookedSession(session) ? "Yes" : "No",
    "Furthest Stage Reached": stageLabel(session.last_step),
    Service: raw(session.job_type),
    "UTM Source": raw(session.utm_source),
    "UTM Medium": raw(session.utm_medium),
    "UTM Campaign": raw(session.utm_campaign),
    stage_number: stageNumber(session.last_step) ?? "",
  };
  for (const f of EXTRA_FIELDS) row[f] = raw(session[f]);
  row.session_id = raw(session.id);
  for (const f of FOLLOW_UP_COLUMNS) row[f] = "";
  row.person_key = personKey(session) ?? "";
  return row;
}

/** A lead row plus what the annotators need from its session. */
export interface Lead {
  row: Row;
  session: Row;
  /** session_created_at as-is, "YYYY-MM-DD HH:mm:ss", for ordering. */
  at: string;
  booked: boolean;
}

export function toLead(session: Row, tenantSlug: string): Lead {
  return { row: toLeadRow(session, tenantSlug), session, at: text(session.session_created_at), booked: isBookedSession(session) };
}

/**
 * The end of a lead's follow-up window: the same local minute `days` later.
 * Capping per lead keeps a lead's flags the same whether it is pulled in a
 * one-day digest or a month-long range.
 */
export function followUpCutoff(at: string, days: number): string {
  const stamp = localStamp(at);
  return `${addDays(stamp.slice(0, 10), days)}${stamp.slice(10)}`;
}

/**
 * Attempt numbers and rebookings. `all` is every lead session in the look
 * window, `leads` the ones being returned (a subset of `all`). A later
 * completed session for the same person within `windowDays` marks an
 * abandoned lead booked_later.
 */
export function annotateRepeats(leads: Lead[], all: Lead[], windowDays: number): void {
  const byPerson = new Map<string, Lead[]>();
  for (const l of all) {
    const key = text(l.row.person_key);
    if (!key) continue;
    const list = byPerson.get(key) ?? [];
    list.push(l);
    byPerson.set(key, list);
  }
  for (const list of byPerson.values()) list.sort((a, b) => a.at.localeCompare(b.at) || text(a.row.session_id).localeCompare(text(b.row.session_id)));
  for (const lead of leads) {
    const key = text(lead.row.person_key);
    const list = key ? (byPerson.get(key) ?? [lead]) : [lead];
    const index = list.findIndex((l) => l.session === lead.session || (l.row.session_id !== "" && l.row.session_id === lead.row.session_id));
    lead.row.sessions_for_person = list.length;
    lead.row.attempt = index >= 0 ? index + 1 : 1;
    if (lead.booked) continue;
    const cutoff = followUpCutoff(lead.at, windowDays);
    const later = list.find((l) => l.booked && l.at > lead.at && localStamp(l.at) <= cutoff);
    lead.row.booked_later = later ? "Yes" : "No";
    lead.row.booked_later_at = later ? exportDate(later.at) : "";
    lead.row.booked_later_job_id = later ? text(later.session.booked_job_id) : "";
  }
}

/** The fields of an inbound interaction that follow-up matching needs. */
export interface Contact {
  phone: string;
  /** localStamp of the interaction's date. */
  at: string;
  via: string;
  category: string;
  jobId: string;
}

export const MODALITY_LABELS: Record<string, string> = { call: "Call", inbound_text: "Text", recapture_text: "Recapture text" };

export function toContact(interaction: Row, modality: string): Contact | undefined {
  const phone = phoneKey(interaction.phoneNumber);
  if (!phone) return undefined;
  return {
    phone,
    at: localStamp(interaction.date),
    via: MODALITY_LABELS[modality] ?? modality,
    category: text(interaction.category),
    jobId: text(interaction.jobId) || text(interaction.postTransferJobId),
  };
}

/**
 * The first Netic inbound call or text from the lead's phone at or after the
 * session's minute (interactions carry minutes, not seconds, and no address),
 * within `windowDays`. Abandoned leads only.
 */
export function annotateContacts(leads: Lead[], contacts: Contact[], windowDays: number): void {
  const byPhone = new Map<string, Contact[]>();
  for (const c of contacts) {
    const list = byPhone.get(c.phone) ?? [];
    list.push(c);
    byPhone.set(c.phone, list);
  }
  for (const list of byPhone.values()) list.sort((a, b) => a.at.localeCompare(b.at));
  for (const lead of leads) {
    if (lead.booked) continue;
    const phone = phoneKey(lead.row["Phone Number"]);
    const since = localStamp(lead.at);
    const cutoff = followUpCutoff(lead.at, windowDays);
    const first = phone ? byPhone.get(phone)?.find((c) => c.at >= since && c.at <= cutoff) : undefined;
    lead.row.contacted_later = first ? "Yes" : "No";
    lead.row.contacted_later_at = first ? exportDate(first.at) : "";
    lead.row.contacted_later_via = first?.via ?? "";
    lead.row.contacted_later_category = first?.category ?? "";
    lead.row.contacted_later_job_id = first?.jobId ?? "";
  }
}

/** Abandoned, then booked online later, or reached Netic later and got a job or a Booked category. */
export function markRecovered(leads: Lead[]): void {
  for (const lead of leads) {
    if (lead.booked) continue;
    const r = lead.row;
    const viaContact = r.contacted_later === "Yes" && (text(r.contacted_later_job_id) !== "" || text(r.contacted_later_category).toLowerCase() === "booked");
    r.recovered = r.booked_later === "Yes" || viaContact ? "Yes" : "No";
  }
}

export interface ValueCount {
  value: string;
  count: number;
}

export interface LeadSummary {
  leads: number;
  booked: number;
  abandoned: number;
  /** Abandoned leads that later booked or got a job through Netic. */
  recovered: number;
  /** Abandoned and not recovered: the ones that still need a call. */
  stillBounced: number;
  /** Breakdowns of the abandoned leads. */
  abandonedBy: Record<string, ValueCount[]>;
}

export const SUMMARY_BREAKDOWNS: Record<string, string> = {
  furthestStage: "Furthest Stage Reached",
  service: "Service",
  marketingSource: "marketing_source",
  utmSource: "UTM Source",
  bookedFrom: "booked_from",
  blockerType: "blocker_type",
};

function tally(rows: Row[], field: string, top: number): ValueCount[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const v = text(r[field]) || "(blank)";
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, top);
}

export function summarize(rows: Row[], top = 10): LeadSummary {
  const abandoned = rows.filter((r) => r.Booked !== "Yes");
  const recovered = abandoned.filter((r) => r.recovered === "Yes").length;
  const abandonedBy: Record<string, ValueCount[]> = {};
  for (const [key, field] of Object.entries(SUMMARY_BREAKDOWNS)) abandonedBy[key] = tally(abandoned, field, top);
  return {
    leads: rows.length,
    booked: rows.length - abandoned.length,
    abandoned: abandoned.length,
    recovered,
    stillBounced: abandoned.length - recovered,
    abandonedBy,
  };
}
