import fs from "node:fs/promises";
import path from "node:path";
import type { Row } from "./client.js";

/**
 * Inbound AI call transcripts. The public API does not return them (probed
 * 2026-09-30, docs/netic-api.md), but the dashboard's Calls Drill Down CSV
 * export carries an "AI Call Transcript" column. This module reads that CSV
 * and joins it onto `/interactions?modality=call` rows. If Netic adds the
 * field to the API, `apiTranscript` picks it up and the CSV is not needed.
 * Pure functions plus file reads; fetching lives in src/tools/transcripts.ts.
 */

export const CSV_COLUMNS = {
  tenant: "Tenant",
  phone: "Phone Number",
  date: "Date",
  stCallId: "ServiceTitan Call ID",
  duration: "Total Call Duration",
  transcript: "AI Call Transcript",
} as const;

/** Row keys Netic might use if it adds transcripts to the API. */
export const API_TRANSCRIPT_KEYS = ["aiCallTranscript", "transcript", "callTranscript"] as const;

/** Columns the transcript tools add to an interaction row. */
export const TRANSCRIPT_FIELDS = ["transcript", "transcriptChars", "agentTurns", "userTurns", "firstUserLine"] as const;

const FILE_PATTERN = /^drilldown_export.*\.csv$/i;

/** RFC 4180: quoted fields, doubled quotes, CR/LF inside quotes, optional BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface DrilldownRow {
  tenant: string;
  phone: string;
  date: string;
  stCallId: string;
  duration: string;
  transcript: string;
}

export interface Drilldown {
  path: string;
  tenant: string;
  rows: DrilldownRow[];
  /** Earliest and latest `Date`, as MM/dd/yyyy HH:mm. */
  first: string;
  last: string;
  withTranscript: number;
}

/** MM/dd/yyyy HH:mm -> yyyy-MM-dd HH:mm, so dates sort as strings. */
export function sortableDate(date: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(.*)$/.exec(date);
  return m ? `${m[3]}-${m[1]}-${m[2]}${m[4]}` : date;
}

export class TranscriptSourceError extends Error {
  override name = "TranscriptSourceError";
}

export function drilldownFromText(text: string, file: string): Drilldown {
  const [header, ...body] = parseCsv(text);
  if (!header) throw new TranscriptSourceError(`${file} is empty.`);
  const index: Partial<Record<keyof typeof CSV_COLUMNS, number>> = {};
  for (const [key, name] of Object.entries(CSV_COLUMNS) as Array<[keyof typeof CSV_COLUMNS, string]>) {
    const at = header.indexOf(name);
    if (at >= 0) index[key] = at;
  }
  if (index.transcript === undefined) {
    throw new TranscriptSourceError(
      `${file} has no "${CSV_COLUMNS.transcript}" column. That column is only in the Calls Drill Down export; the texts export has none.`,
    );
  }
  const missing = (Object.keys(CSV_COLUMNS) as Array<keyof typeof CSV_COLUMNS>).filter((k) => index[k] === undefined);
  if (missing.length > 0) {
    throw new TranscriptSourceError(`${file} is missing column(s) ${missing.map((k) => `"${CSV_COLUMNS[k]}"`).join(", ")}.`);
  }
  const at = (cells: string[], key: keyof typeof CSV_COLUMNS) => cells[index[key] as number] ?? "";
  const rows: DrilldownRow[] = [];
  const tenants = new Set<string>();
  let first = "";
  let last = "";
  let withTranscript = 0;
  for (const cells of body) {
    if (cells.length === 1 && cells[0] === "") continue;
    const row: DrilldownRow = {
      tenant: at(cells, "tenant"),
      phone: at(cells, "phone"),
      date: at(cells, "date"),
      stCallId: at(cells, "stCallId"),
      duration: at(cells, "duration"),
      transcript: at(cells, "transcript"),
    };
    rows.push(row);
    tenants.add(row.tenant);
    if (row.transcript) withTranscript += 1;
    const s = sortableDate(row.date);
    if (!first || s < sortableDate(first)) first = row.date;
    if (!last || s > sortableDate(last)) last = row.date;
  }
  if (tenants.size > 1) throw new TranscriptSourceError(`${file} mixes tenants (${[...tenants].join(", ")}); export one brand at a time.`);
  return { path: file, tenant: [...tenants][0] ?? "", rows, first, last, withTranscript };
}

const cache = new Map<string, { mtimeMs: number; size: number; data: Drilldown }>();

/** Parse a Drill Down CSV once per file version. */
export async function loadDrilldown(file: string): Promise<Drilldown> {
  const resolved = path.resolve(file);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new TranscriptSourceError(`Transcript CSV not found: ${resolved}.`);
  }
  const hit = cache.get(resolved);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.data;
  const data = drilldownFromText(await fs.readFile(resolved, "utf8"), resolved);
  if (cache.size >= 4) cache.delete(cache.keys().next().value as string);
  cache.set(resolved, { mtimeMs: stat.mtimeMs, size: stat.size, data });
  return data;
}

/** Header line and the first data row's Tenant, without reading the whole file. */
async function peek(file: string): Promise<{ header: string[]; tenant: string } | undefined> {
  const handle = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(16_384);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const lines = buf.subarray(0, bytesRead).toString("utf8").replace(/^﻿/, "").split(/\r?\n/);
    const header = (lines[0] ?? "").split(",");
    const tenantAt = header.indexOf(CSV_COLUMNS.tenant);
    const firstRow = lines[1] ?? "";
    const tenantCell = tenantAt === 0 ? (firstRow.startsWith('"') ? firstRow.slice(1, firstRow.indexOf('"', 1)) : firstRow.split(",")[0]) : "";
    return { header, tenant: tenantCell ?? "" };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/** How to get the file, for errors and tool descriptions. */
export const EXPORT_HOWTO =
  "In the Netic dashboard open Analytics, then the Drill Down for Calls, set the date range, and export it (the file is named drilldown_export_<date>.csv). Save it to the transcript folder, or pass its path as csv_path.";

/**
 * The newest `drilldown_export*.csv` in `dir` that has the transcript column
 * and belongs to `tenantName` (Netic's display name, e.g. "NASH Hoffmann").
 */
export async function findDrilldownCsv(dir: string, tenantName: string): Promise<string> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    throw new TranscriptSourceError(`The transcript folder ${dir} does not exist. ${EXPORT_HOWTO}`);
  }
  const candidates = await Promise.all(
    names
      .filter((n) => FILE_PATTERN.test(n))
      .map(async (n) => {
        const file = path.join(dir, n);
        const stat = await fs.stat(file).catch(() => undefined);
        return stat?.isFile() ? { file, mtimeMs: stat.mtimeMs } : undefined;
      }),
  );
  const sorted = candidates.filter((c): c is { file: string; mtimeMs: number } => !!c).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const wanted = tenantName.trim().toLowerCase();
  let otherTenant = 0;
  let noTranscript = 0;
  for (const c of sorted) {
    const p = await peek(c.file);
    if (!p) continue;
    if (!p.header.includes(CSV_COLUMNS.transcript)) {
      noTranscript += 1;
      continue;
    }
    if (p.tenant.trim().toLowerCase() !== wanted) {
      otherTenant += 1;
      continue;
    }
    return c.file;
  }
  const skipped = sorted.length > 0 ? ` Skipped ${sorted.length} drilldown file(s): ${noTranscript} without the transcript column (texts exports), ${otherTenant} for another tenant.` : "";
  throw new TranscriptSourceError(`No Calls Drill Down CSV for ${tenantName} in ${dir}.${skipped} ${EXPORT_HOWTO}`);
}

export function apiTranscript(row: Row): string | undefined {
  for (const key of API_TRANSCRIPT_KEYS) {
    const v = row[key];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

export interface Turn {
  speaker: string;
  text: string;
}

const TURN = /(?:^|\n)(Agent|User):[ \t]?/g;

/** Split "Agent: …\nUser: …" into turns. Text before the first label is one unlabeled turn. */
export function turns(transcript: string): Turn[] {
  const out: Turn[] = [];
  const marks = [...transcript.matchAll(TURN)];
  const lead = marks.length > 0 ? transcript.slice(0, marks[0]!.index).trim() : transcript.trim();
  if (lead) out.push({ speaker: "", text: lead });
  for (const [i, m] of marks.entries()) {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1]!.index : transcript.length;
    out.push({ speaker: m[1]!, text: transcript.slice(start, end).trim() });
  }
  return out;
}

export function transcriptFeatures(transcript: string): Pick<Row, "transcriptChars" | "agentTurns" | "userTurns" | "firstUserLine"> {
  const t = turns(transcript);
  return {
    transcriptChars: transcript.length,
    agentTurns: t.filter((x) => x.speaker === "Agent").length,
    userTurns: t.filter((x) => x.speaker === "User").length,
    firstUserLine: t.find((x) => x.speaker === "User")?.text.slice(0, 300) ?? "",
  };
}

export interface JoinStats {
  source: "api" | "csv" | "none";
  csvPath?: string;
  /** Coverage of the CSV, MM/dd/yyyy HH:mm. */
  csvFirst?: string;
  csvLast?: string;
  apiRows: number;
  /** API rows with a transcript attached (from either source). */
  withTranscript: number;
  /** API rows matched to a CSV row whose transcript is blank. */
  matchedBlank: number;
  /** API rows with no CSV row. */
  unmatched: number;
  /** API rows left unmatched because several CSV rows fit equally. */
  ambiguous: number;
  /** CSV rows inside the API rows' date span that no API row took. */
  csvUnused: number;
}

const key = (phone: unknown, date: unknown) => `${String(phone ?? "")}|${String(date ?? "")}`;

/**
 * Attach transcripts to interaction rows. API-supplied transcripts win.
 * Otherwise match on phone and minute (identical strings in API and CSV),
 * breaking ties by ServiceTitan call id and then total duration. Rows that
 * still tie take the CSV rows in order only when those rows' transcripts are
 * identical; otherwise they stay unmatched and are counted as ambiguous.
 */
export function attachTranscripts(apiRows: Row[], drilldown: Drilldown | undefined): { rows: Row[]; stats: JoinStats } {
  const stats: JoinStats = { source: "none", apiRows: apiRows.length, withTranscript: 0, matchedBlank: 0, unmatched: 0, ambiguous: 0, csvUnused: 0 };
  const fromApi = apiRows.map(apiTranscript);
  if (fromApi.some((t) => t !== undefined)) {
    stats.source = "api";
    const rows = apiRows.map((r, i) => {
      const t = fromApi[i];
      if (t === undefined) {
        stats.unmatched += 1;
        return r;
      }
      stats.withTranscript += 1;
      return { ...r, transcript: t, ...transcriptFeatures(t) };
    });
    return { rows, stats };
  }
  if (!drilldown) {
    stats.unmatched = apiRows.length;
    return { rows: apiRows, stats };
  }
  stats.source = "csv";
  stats.csvPath = drilldown.path;
  stats.csvFirst = drilldown.first;
  stats.csvLast = drilldown.last;
  const byKey = new Map<string, DrilldownRow[]>();
  for (const r of drilldown.rows) {
    const k = key(r.phone, r.date);
    const list = byKey.get(k);
    if (list) list.push(r);
    else byKey.set(k, [r]);
  }
  const used = new Set<DrilldownRow>();
  const rows = apiRows.map((r) => {
    let candidates = (byKey.get(key(r.phoneNumber, r.date)) ?? []).filter((c) => !used.has(c));
    if (candidates.length > 1) {
      const st = String(r.serviceTitanCallId ?? "");
      const bySt = candidates.filter((c) => c.stCallId === st);
      if (bySt.length > 0) candidates = bySt;
    }
    if (candidates.length > 1) {
      const dur = String(r.callDurationTotal ?? "");
      const byDur = candidates.filter((c) => c.duration === dur);
      if (byDur.length > 0) candidates = byDur;
    }
    if (candidates.length === 0) {
      stats.unmatched += 1;
      return r;
    }
    if (candidates.length > 1 && !candidates.every((c) => c.transcript === candidates[0]!.transcript)) {
      stats.ambiguous += 1;
      return r;
    }
    const hit = candidates[0]!;
    used.add(hit);
    if (!hit.transcript) {
      stats.matchedBlank += 1;
      return r;
    }
    stats.withTranscript += 1;
    return { ...r, transcript: hit.transcript, ...transcriptFeatures(hit.transcript) };
  });
  const dates = apiRows.map((r) => sortableDate(String(r.date ?? ""))).filter(Boolean).sort();
  if (dates.length > 0) {
    const lo = dates[0]!;
    const hi = dates[dates.length - 1]!;
    for (const c of drilldown.rows) {
      const d = sortableDate(c.date);
      if (d >= lo && d <= hi && !used.has(c)) stats.csvUnused += 1;
    }
  }
  return { rows, stats };
}

/** One footer note on where transcripts came from and how complete they are. */
export function joinNotes(s: JoinStats): string[] {
  if (s.source === "api") return [`transcripts from the API on ${s.withTranscript} of ${s.apiRows} call(s)`];
  if (s.source === "none") return ["no transcripts attached"];
  const notes = [
    `transcripts from ${path.basename(s.csvPath ?? "")} (covers ${s.csvFirst} to ${s.csvLast}) on ${s.withTranscript} of ${s.apiRows} call(s)`,
  ];
  const gaps: string[] = [];
  if (s.matchedBlank) gaps.push(`${s.matchedBlank} matched with a blank transcript`);
  if (s.unmatched) gaps.push(`${s.unmatched} not in the CSV`);
  if (s.ambiguous) gaps.push(`${s.ambiguous} ambiguous`);
  if (gaps.length > 0) notes.push(`no transcript: ${gaps.join(", ")}`);
  if (s.unmatched > 0 && s.csvLast) notes.push("calls after the CSV's last date need a newer export");
  return notes;
}

export interface Matcher {
  /** Character ranges of hits in `text`. */
  hits(text: string): Array<[number, number]>;
  /** Whether a whole transcript matches (all terms for match=all). */
  matches(texts: string[]): boolean;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Plain terms (case-insensitive; quote a phrase to keep it whole) matched any
 * or all, or one regular expression.
 */
export function buildMatcher(query: string, opts: { match: "any" | "all"; regex: boolean }): Matcher {
  let patterns: RegExp[];
  if (opts.regex) {
    try {
      patterns = [new RegExp(query, "gi")];
    } catch (err) {
      throw new TranscriptSourceError(`Invalid regex: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    const terms = [...query.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => (m[1] ?? m[2] ?? "").trim()).filter(Boolean);
    if (terms.length === 0) throw new TranscriptSourceError("query is empty.");
    patterns = terms.map((t) => new RegExp(escapeRegex(t), "gi"));
  }
  const all = opts.match === "all" && !opts.regex;
  return {
    hits(text) {
      const out: Array<[number, number]> = [];
      for (const p of patterns) {
        p.lastIndex = 0;
        for (const m of text.matchAll(p)) {
          if (m[0].length === 0) break;
          out.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
        }
      }
      return out.sort((a, b) => a[0] - b[0]);
    },
    matches(texts) {
      const found = patterns.map((p) => texts.some((t) => ((p.lastIndex = 0), p.test(t))));
      return all ? found.every(Boolean) : found.some(Boolean);
    },
  };
}

export type Speaker = "any" | "agent" | "user";

/** The text a search looks at: the whole transcript, or one side's turns. */
export function searchable(transcript: string, speaker: Speaker): Turn[] {
  if (speaker === "any") return turns(transcript);
  const want = speaker === "agent" ? "Agent" : "User";
  return turns(transcript).filter((t) => t.speaker === want);
}

/** Up to `max` snippets around hits, each labeled with its speaker. */
export function snippets(parts: Turn[], matcher: Matcher, width: number, max: number): string[] {
  const out: string[] = [];
  for (const part of parts) {
    let lastEnd = -1;
    for (const [s, e] of matcher.hits(part.text)) {
      if (s < lastEnd) continue;
      const half = Math.max(20, Math.floor((width - (e - s)) / 2));
      const from = Math.max(0, s - half);
      const to = Math.min(part.text.length, e + half);
      const body = `${from > 0 ? "…" : ""}${part.text.slice(from, to).replace(/\s+/g, " ")}${to < part.text.length ? "…" : ""}`;
      out.push(part.speaker ? `${part.speaker}: ${body}` : body);
      lastEnd = to;
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Keep the head and tail of a long transcript. */
export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = Math.floor(max * 0.7);
  const tail = Math.max(0, max - head - 5);
  return { text: `${text.slice(0, head)}\n[…]\n${text.slice(text.length - tail)}`, truncated: true };
}

/** Seeded shuffle (mulberry32 + Fisher-Yates), so a random sample can be paged. */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
