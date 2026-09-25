/**
 * Check docs/vendor/netic-openapi.yaml against the live API for every tenant
 * in .env. GET only, and never web/leads: typed calls go through NeticClient,
 * and the few deliberately invalid calls go through rawGet, which accepts only
 * the six report paths.
 *
 * Raw responses (customer PII) go to probe-output/<date>/<tenant>/, which is
 * gitignored. The console and summary.json carry only key names, types,
 * counts, statuses, and error bodies.
 *
 *   npm run probe            every tenant in .env
 *   npm run probe -- stl     just these tenants
 */
import fs from "node:fs";
import path from "node:path";
import { NeticClient, assertAllowedPath, type Envelope, type QueryParams, type Row } from "../src/client.js";
import { loadConfig, type TenantConfig } from "../src/config.js";
import { addDays } from "../src/dates.js";
import { REPORT_INFO, type Report } from "../src/endpoints.js";
import { describeError } from "../src/format.js";
import { localDate, neticEnv, root } from "./env.js";
import * as SPEC from "./spec-keys.js";

const config = loadConfig(neticEnv());
const wanted = process.argv.slice(2).map((s) => s.toLowerCase());
const tenants = [...config.tenants.values()].filter((t) => wanted.length === 0 || wanted.includes(t.name));
if (tenants.length === 0) {
  console.error("No tenants to probe. Fill NETIC_TENANTS and NETIC_TENANT_<NAME>_TOKEN in .env (see .env.example).");
  process.exit(2);
}
for (const w of config.warnings) console.error(`warning: ${w}`);

const runDay = localDate(0);
const end = localDate(-1);
const start7 = addDays(end, -6);
const outRoot = path.join(root, "probe-output", runDay);
const REPORT_PATHS = new Set(Object.values(REPORT_INFO).map((r) => r.path));

interface Timed<T> {
  ok: boolean;
  ms: number;
  value?: T;
  error?: string;
}

async function timed<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { ok: true, ms: Date.now() - t0, value };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: describeError(err) };
  }
}

interface RawResponse {
  status: number;
  contentType: string;
  ms: number;
  body: unknown;
  text: string;
}

/**
 * GET a report path without the client's preflight, for the checks that must
 * send invalid parameters. Only the six report paths are accepted.
 */
async function rawGet(tenant: TenantConfig | undefined, reportPath: string, params: QueryParams): Promise<RawResponse> {
  assertAllowedPath(reportPath);
  if (!REPORT_PATHS.has(reportPath)) throw new Error(`rawGet refuses ${reportPath}: not a report path.`);
  const url = new URL(reportPath, `${config.baseUrl}/`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { Accept: "application/json" };
  if (tenant) headers.Authorization = `Bearer ${tenant.token}`;
  const t0 = Date.now();
  const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(config.timeoutMs) });
  const text = await res.text();
  let body: unknown = undefined;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", ms: Date.now() - t0, body, text };
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function shape(row: Row | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!row) return out;
  for (const [k, v] of Object.entries(row)) out[k] = typeOf(v);
  return out;
}

function drift(row: Row | undefined, expected: string[]): { missing: string[]; extra: string[] } {
  if (!row) return { missing: [], extra: [] };
  const keys = new Set(Object.keys(row));
  return { missing: expected.filter((k) => !keys.has(k)), extra: [...keys].filter((k) => !expected.includes(k)) };
}

function paginationShape(env: Envelope | undefined): Record<string, string> {
  return env ? Object.fromEntries(Object.entries(env.pagination).map(([k, v]) => [k, typeOf(v)])) : {};
}

/** Only an error body's field names and short strings; no row data. */
function errorShape(r: RawResponse): Record<string, unknown> {
  const body = r.body && typeof r.body === "object" ? (r.body as Record<string, unknown>) : undefined;
  return { status: r.status, contentType: r.contentType, keys: body ? Object.keys(body) : [], body: body ?? r.text.slice(0, 300) };
}

function classify(report: Report, row: Row | undefined): string {
  if (!row) return "no rows";
  const has = (k: string) => k in row;
  if (report === "tgl_bookings") return has("booked_by_technician_id") || has("job_type_name") ? "ServiceTitan" : has("outcome_type") || has("account_number") ? "Cargas" : "unknown";
  if (report === "scheduler_bookings") return has("service_titan_job_id") ? "ServiceTitan" : has("customer_name") || has("outcome_type") ? "session-based" : "unknown";
  return "n/a";
}

const SPEC_KEYS: Record<Report, (row: Row | undefined) => string[]> = {
  interactions: () => SPEC.INTERACTION_KEYS,
  scheduler_sessions: () => SPEC.SCHEDULER_SESSION_KEYS,
  scheduler_bookings: (row) => (row && "service_titan_job_id" in row ? SPEC.SCHEDULER_BOOKING_SERVICETITAN_KEYS : SPEC.SCHEDULER_BOOKING_SESSION_KEYS),
  tgl_bookings: (row) => (row && "outcome_type" in row ? SPEC.TGL_CARGAS_KEYS : SPEC.TGL_SERVICETITAN_KEYS),
  referrer_bookings: () => SPEC.REFERRER_KEYS,
  outbound_calls: () => SPEC.OUTBOUND_KEYS,
};

/** MM/dd/yyyy HH:mm -> YYYY-MM-DD, or undefined. */
function interactionDay(value: unknown): string | undefined {
  const m = typeof value === "string" ? /^(\d{2})\/(\d{2})\/(\d{4}) \d{2}:\d{2}$/.exec(value) : null;
  return m ? `${m[3]}-${m[1]}-${m[2]}` : undefined;
}

async function probeTenant(t: TenantConfig): Promise<Record<string, unknown>> {
  const client = new NeticClient({ tenant: t.name, token: t.token, baseUrl: config.baseUrl, timeoutMs: config.timeoutMs });
  const dir = path.join(outRoot, t.name);
  fs.mkdirSync(dir, { recursive: true });
  const save = (name: string, body: unknown) => fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(body, null, 2));
  const summary: Record<string, unknown> = { tenant: t.name };
  const range7 = { createdOnOrAfter: start7, createdBefore: end };
  const tenantValues = new Set<string>();
  const noteTenant = (rows: Row[]) => rows.forEach((r) => typeof r.tenant === "string" && tenantValues.add(r.tenant));

  // 1 and 2: auth, envelope, row shape, and variant for every endpoint.
  const endpoints: Record<string, unknown> = {};
  const targets: Array<[string, Report, QueryParams]> = [
    ["interactions.call", "interactions", { modality: "call" }],
    ["interactions.inbound_text", "interactions", { modality: "inbound_text" }],
    ["interactions.recapture_text", "interactions", { modality: "recapture_text" }],
    ["scheduler_sessions", "scheduler_sessions", {}],
    ["scheduler_bookings", "scheduler_bookings", {}],
    ["tgl_bookings", "tgl_bookings", {}],
    ["referrer_bookings", "referrer_bookings", {}],
    ["outbound_calls", "outbound_calls", {}],
  ];
  for (const [label, report, extra] of targets) {
    const path_ = REPORT_INFO[report].path;
    let r = await timed(() => client.getPage(path_, { ...range7, ...extra, page: 1, pageSize: 1 }));
    let window = "7d";
    if (r.ok && r.value && r.value.data.length === 0) {
      const wider = await timed(() => client.getPage(path_, { createdOnOrAfter: addDays(end, -89), createdBefore: end, ...extra, page: 1, pageSize: 1 }));
      if (wider.ok && wider.value && wider.value.data.length > 0) {
        r = wider;
        window = "90d";
      }
    }
    if (r.value) save(`1-${label}`, r.value);
    const row = r.value?.data[0];
    if (row) noteTenant([row]);
    endpoints[label] = {
      ok: r.ok,
      ms: r.ms,
      error: r.error,
      window,
      envelopeKeys: r.value ? Object.keys(r.value) : [],
      pagination: paginationShape(r.value),
      totalRecords: r.value?.pagination.totalRecords,
      variant: classify(report, row),
      rowShape: shape(row),
      drift: drift(row, SPEC_KEYS[report](row)),
    };
  }
  summary.endpoints = endpoints;

  // 3: inclusive bounds. Seven single days should sum to the seven-day total,
  // and a single-day pull should only hold that day's rows.
  const interactions = REPORT_INFO.interactions.path;
  const call = { modality: "call" };
  const total7 = await timed(() => client.getPage(interactions, { ...range7, ...call, pageSize: 1 }));
  const perDay: Record<string, number | string> = {};
  let busiest: string | undefined;
  for (let i = 0; i < 7; i += 1) {
    const d = addDays(start7, i);
    const r = await timed(() => client.getPage(interactions, { createdOnOrAfter: d, createdBefore: d, ...call, pageSize: 1 }));
    perDay[d] = r.value?.pagination.totalRecords ?? `error: ${r.error}`;
    if (typeof perDay[d] === "number" && (busiest === undefined || (perDay[d] as number) > (perDay[busiest] as number))) busiest = d;
  }
  const daySum = Object.values(perDay).reduce<number>((s, v) => s + (typeof v === "number" ? v : 0), 0);
  let singleDay: Record<string, unknown> = { skipped: "no busy day" };
  if (busiest && (perDay[busiest] as number) > 0) {
    const r = await timed(() => client.getPage(interactions, { createdOnOrAfter: busiest, createdBefore: busiest, ...call, pageSize: 5000 }));
    if (r.value) save("3-single-day", r.value);
    const days = new Map<string, number>();
    for (const row of r.value?.data ?? []) {
      const d = interactionDay(row.date) ?? `unparsed:${String(row.date).slice(0, 5)}`;
      days.set(d, (days.get(d) ?? 0) + 1);
    }
    singleDay = { day: busiest, rows: r.value?.data.length, rowDates: Object.fromEntries(days), allOnThatDay: days.size === 1 && days.has(busiest) };
  }
  summary.inclusiveBounds = { total7: total7.value?.pagination.totalRecords, sumOfSingleDays: daySum, match: total7.value?.pagination.totalRecords === daySum, perDay, singleDay };

  // 4: maximum date range.
  const ranges: Record<string, unknown> = {};
  for (const days of [31, 92, 366, 731]) {
    const r = await timed(() => client.getPage(interactions, { createdOnOrAfter: addDays(end, -(days - 1)), createdBefore: end, ...call, pageSize: 1 }));
    ranges[`${days}d`] = { ok: r.ok, ms: r.ms, totalRecords: r.value?.pagination.totalRecords, error: r.error };
  }
  summary.rangeLimit = ranges;

  // 5: page size boundary and latency.
  const big = await timed(() => client.getPage(interactions, { ...range7, ...call, pageSize: 5000 }));
  if (big.value) {
    save("5-pagesize-5000", big.value);
    noteTenant(big.value.data);
  }
  const over = await rawGet(t, interactions, { ...range7, ...call, pageSize: 5001 });
  const zero = await rawGet(t, interactions, { ...range7, ...call, pageSize: 0 });
  const dateFormats = new Set((big.value?.data ?? []).map((r) => (interactionDay(r.date) ? "MM/dd/yyyy HH:mm" : `other: ${String(r.date).replace(/\d/g, "9")}`)));
  const modalities = new Set((big.value?.data ?? []).map((r) => String(r.modality)));
  summary.pageSize = {
    size5000: { ok: big.ok, ms: big.ms, rows: big.value?.data.length, totalRecords: big.value?.pagination.totalRecords, error: big.error },
    size5001: errorShape(over),
    size0: errorShape(zero),
    interactionDateFormats: [...dateFormats],
    rowModalityValues: [...modalities],
  };

  // 6: documented error shapes.
  summary.errors = {
    badModality: errorShape(await rawGet(t, interactions, { ...range7, modality: "bogus" })),
    missingCreatedBefore: errorShape(await rawGet(t, interactions, { createdOnOrAfter: start7, modality: "call" })),
    endBeforeStart: errorShape(await rawGet(t, interactions, { createdOnOrAfter: end, createdBefore: start7, modality: "call" })),
    noToken: errorShape(await rawGet(undefined, REPORT_INFO.referrer_bookings.path, range7)),
  };

  // 7: outbound calls default to CSV; record only the header line.
  const csv = await rawGet(t, REPORT_INFO.outbound_calls.path, { ...range7, pageSize: 1 });
  fs.writeFileSync(path.join(dir, "7-outbound-default.txt"), csv.text);
  summary.outboundDefault = { status: csv.status, contentType: csv.contentType, csvHeader: csv.text.split(/\r?\n/)[0]?.slice(0, 500) };

  // 8: tenant isolation. Every row's tenant field should name this token's tenant.
  summary.tenantFieldValues = [...tenantValues];
  summary.apiCalls = client.requestCount;
  return summary;
}

fs.mkdirSync(outRoot, { recursive: true });
const all: Record<string, unknown>[] = [];
for (const t of tenants) {
  console.error(`probing ${t.name} (${start7} to ${end})...`);
  try {
    all.push(await probeTenant(t));
  } catch (err) {
    all.push({ tenant: t.name, fatal: describeError(err) });
  }
}
// Merge into the day's summary so probing one tenant keeps the others' results.
const summaryPath = path.join(outRoot, "summary.json");
let previous: Array<Record<string, unknown>> = [];
try {
  previous = (JSON.parse(fs.readFileSync(summaryPath, "utf8")) as { tenants?: Array<Record<string, unknown>> }).tenants ?? [];
} catch {
  /* first run today */
}
const probed = new Set(all.map((t) => t.tenant));
const summary = { runDay, baseUrl: config.baseUrl, start7, end, tenants: [...previous.filter((t) => !probed.has(t.tenant)), ...all] };
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.error(`\nRaw responses (PII, gitignored): ${outRoot}`);
