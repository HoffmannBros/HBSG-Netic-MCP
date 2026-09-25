import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import { NeticApiError, NeticConfigError, NeticRequestError, type Row } from "./client.js";
import { DateError } from "./dates.js";

export function formatCell(value: unknown, maxLength = 200): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    text = Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  } else {
    text = typeof value === "string" ? value : JSON.stringify(value);
  }
  text = text.replace(/\r?\n/g, " ");
  if (text.length > maxLength) text = `${text.slice(0, maxLength - 1)}…`;
  return text.replace(/\|/g, "\\|");
}

export function markdownTable(rows: Row[], columns: string[], maxCell = 200): string {
  if (rows.length === 0) return "(no rows)";
  const header = `| ${columns.join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${columns.map((c) => formatCell(r[c], maxCell)).join(" | ")} |`);
  return [header, sep, ...body].join("\n");
}

export interface FooterInfo {
  tenant: string;
  label: string;
  start: string;
  end: string;
  /** Rows returned inline, written to a file, or counted. */
  returned: number;
  totalRecords: number;
  hasMore: boolean;
  /** Rows scanned, when a client-side filter dropped some. */
  scanned?: number | undefined;
  filtered?: boolean | undefined;
  apiCalls: number;
  /** What to do about `hasMore`, e.g. which tool pulls the rest. */
  moreHint?: string | undefined;
  /** Extra facts for the end of the footer, e.g. timezone and snapshot. */
  notes?: string[] | undefined;
}

/**
 * The footer every data tool ends with. It is load-bearing: it is how the
 * model knows whether it has every row or a sample.
 */
export function footer(f: FooterInfo): string {
  const rows = f.filtered
    ? `${f.returned} matching row(s) from ${f.scanned ?? 0} scanned of ${f.totalRecords} in range`
    : `${f.returned} of ${f.totalRecords} row(s)`;
  const more = f.hasMore ? `hasMore: true${f.moreHint ? `. ${f.moreHint}` : ""}` : "hasMore: false";
  const notes = f.notes && f.notes.length > 0 ? ` · ${f.notes.join(" · ")}` : "";
  return `---\ntenant ${f.tenant} · ${f.label} · ${f.start} to ${f.end} (both inclusive, tenant local time) · ${rows} · ${more} · ${f.apiCalls} API call(s)${notes}`;
}

export function textResult(text: string, structured?: Record<string, unknown>): CallToolResult {
  const result: CallToolResult = { content: [{ type: "text", text }] };
  if (structured) result.structuredContent = structured;
  return result;
}

export function describeError(err: unknown): string {
  if (err instanceof NeticApiError || err instanceof NeticConfigError || err instanceof NeticRequestError || err instanceof DateError) {
    return err.message;
  }
  if (err instanceof ZodError) {
    return `Invalid arguments: ${err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function errorResult(err: unknown): CallToolResult {
  return { content: [{ type: "text", text: describeError(err) }], isError: true };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
