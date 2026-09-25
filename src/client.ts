import { setTimeout as sleepFor } from "node:timers/promises";
import { DateError, rangeViolation } from "./dates.js";
import { MODALITIES, PATH_PREFIX, REPORT_INFO } from "./endpoints.js";

export type QueryParams = Record<string, string | number | boolean | undefined>;
export type Row = Record<string, unknown>;

export interface Pagination {
  page: number;
  pageSize: number;
  totalRecords: number;
  totalPages: number;
  hasMore: boolean;
}

/** Every report endpoint answers with this envelope. */
export interface Envelope<T = Row> {
  data: T[];
  pagination: Pagination;
}

export const MAX_PAGE_SIZE = 5000;

const REPORT_PATHS = new Set(Object.values(REPORT_INFO).map((r) => r.path));
const INTERACTIONS_PATH = REPORT_INFO.interactions.path;
const OUTBOUND_PATH = REPORT_INFO.outbound_calls.path;

export class NeticApiError extends Error {
  override name = "NeticApiError";
  constructor(
    readonly status: number,
    readonly apiError: string,
    readonly tenant: string,
    readonly path: string,
    readonly hint: string,
    readonly details: Array<{ field?: string; message?: string }> = [],
    readonly apiHint?: string,
  ) {
    const parts = [`Netic API ${status} for tenant ${tenant} on ${path}: ${apiError}`];
    if (details.length > 0) {
      parts.push(`Details: ${details.map((d) => `${d.field ?? "?"}: ${d.message ?? "?"}`).join("; ")}.`);
    }
    if (apiHint) parts.push(`Netic hint: ${apiHint}`);
    if (hint) parts.push(hint);
    super(parts.join(" "));
  }
}

/** Refused locally: a request the MCP must never send, or one the API is certain to reject. */
export class NeticRequestError extends Error {
  override name = "NeticRequestError";
}

export class NeticConfigError extends Error {
  override name = "NeticConfigError";
}

/**
 * The same tenant token authorizes `/api/public/metrics/web/leads`, which
 * submits real leads. Everything under `web` is refused, as is anything
 * outside the metrics prefix or anything that could be normalized into a
 * different path by the URL parser.
 */
export function assertAllowedPath(path: string): void {
  if (!path.startsWith(PATH_PREFIX)) {
    throw new NeticRequestError(`Path must start with ${PATH_PREFIX}; got "${path}".`);
  }
  if (/[?#%\\]/.test(path) || path.includes("//") || /(^|\/)\.\.?(\/|$)/.test(path)) {
    throw new NeticRequestError(`Path "${path}" contains characters that are not allowed. Pass query parameters separately.`);
  }
  if (/\/web(\/|$)/i.test(path)) {
    throw new NeticRequestError(
      "Refused: /api/public/metrics/web/* is the web-leads endpoint, which submits real leads. This MCP is read-only and never calls it.",
    );
  }
}

function hintFor(status: number, tenant: string): string {
  switch (status) {
    case 401:
      return `The token for tenant "${tenant}" was rejected. Check it in Claude Desktop under Settings, Extensions, Netic, or in .env as NETIC_TENANT_${tenant.toUpperCase().replace(/-/g, "_")}_TOKEN.`;
    case 400:
      return "Check the dates (YYYY-MM-DD, both inclusive), modality, page, and pageSize (1 to 5000).";
    case 404:
      return "That path does not exist. The report endpoints are listed in netic_api_call's description.";
    case 429:
      return "Netic is rate limiting. Wait a minute and retry with fewer, larger pages.";
    case 500:
    case 502:
    case 503:
    case 504:
      return "Netic had a server error. Retry, or use a shorter date range.";
    default:
      return "";
  }
}

async function parseErrorBody(res: Response): Promise<{ error: string; details: Array<{ field?: string; message?: string }>; hint?: string }> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown; details?: unknown; hint?: unknown };
    const error = [parsed.error, parsed.message].filter((v): v is string => typeof v === "string" && v !== "").join(": ");
    const details = Array.isArray(parsed.details) ? (parsed.details as Array<{ field?: string; message?: string }>) : [];
    const out: { error: string; details: Array<{ field?: string; message?: string }>; hint?: string } = {
      error: error || res.statusText || `HTTP ${res.status}`,
      details,
    };
    if (typeof parsed.hint === "string") out.hint = parsed.hint;
    return out;
  } catch {
    return { error: text.trim().slice(0, 500) || res.statusText || `HTTP ${res.status}`, details: [] };
  }
}

function intParam(value: string | number | boolean | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) ? n : Number.NaN;
}

export function isEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== "object") return false;
  const v = value as { data?: unknown; pagination?: unknown };
  return Array.isArray(v.data) && !!v.pagination && typeof v.pagination === "object";
}

export interface ClientOptions {
  tenant: string;
  token: string;
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

/** One client per tenant. GET only. */
export class NeticClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  /** Requests actually sent during this process, including retries. */
  requestCount = 0;

  constructor(private readonly opts: ClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => sleepFor(ms));
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  get tenant(): string {
    return this.opts.tenant;
  }

  buildUrl(path: string, params: QueryParams = {}): string {
    const base = new URL(`${this.opts.baseUrl}/`);
    const url = new URL(path, base);
    if (url.origin !== base.origin || url.pathname !== path) {
      throw new NeticRequestError(`Path "${path}" does not resolve to itself under ${base.origin}.`);
    }
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * Reject a request the API is certain to refuse, before it is sent. Also
   * forces `format=json` on outbound calls, which default to CSV.
   */
  preflight(path: string, params: QueryParams): QueryParams {
    assertAllowedPath(path);
    const out: QueryParams = { ...params };
    const isReport = REPORT_PATHS.has(path);
    const start = out.createdOnOrAfter === undefined ? undefined : String(out.createdOnOrAfter);
    const end = out.createdBefore === undefined ? undefined : String(out.createdBefore);
    if (isReport || start !== undefined || end !== undefined) {
      const violation = rangeViolation(start, end);
      if (violation) throw new DateError(violation);
    }
    const page = intParam(out.page);
    if (page !== undefined && !(page >= 1)) throw new NeticRequestError(`page must be an integer of 1 or more; got ${String(out.page)}.`);
    const pageSize = intParam(out.pageSize);
    if (pageSize !== undefined && !(pageSize >= 1 && pageSize <= MAX_PAGE_SIZE)) {
      throw new NeticRequestError(`pageSize must be an integer from 1 to ${MAX_PAGE_SIZE}; got ${String(out.pageSize)}.`);
    }
    if (path === INTERACTIONS_PATH) {
      const modality = out.modality === undefined ? undefined : String(out.modality);
      if (!modality || !(MODALITIES as readonly string[]).includes(modality)) {
        throw new NeticRequestError(`modality is required on interactions and must be one of ${MODALITIES.join(", ")}.`);
      }
    }
    if (path === OUTBOUND_PATH) out.format = "json";
    return out;
  }

  /** The only way a request leaves this process. Anything but GET throws. */
  async request<T = unknown>(method: string, path: string, params: QueryParams = {}): Promise<T> {
    if (method.toUpperCase() !== "GET") {
      throw new NeticRequestError(`Refused ${method}: the Netic MCP is GET only.`);
    }
    const finalParams = this.preflight(path, params);
    const url = this.buildUrl(path, finalParams);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      this.requestCount += 1;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${this.opts.token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
      } catch (err) {
        if (attempt < this.maxAttempts) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        const reason = err instanceof Error ? err.message : String(err);
        throw new NeticApiError(0, `Network error: ${reason}`, this.tenant, path, "Check the connection and retry.");
      }

      if (res.ok) {
        const type = res.headers.get("content-type") ?? "";
        if (!/json/i.test(type)) {
          const body = (await res.text().catch(() => "")).slice(0, 200);
          throw new NeticApiError(res.status, `Expected JSON but got ${type || "no content type"}: ${body}`, this.tenant, path, "");
        }
        return (await res.json()) as T;
      }

      const body = await parseErrorBody(res);
      const retryAfterRaw = res.headers.get("retry-after");
      const retryAfter = retryAfterRaw && /^\d+$/.test(retryAfterRaw) ? Number(retryAfterRaw) : undefined;
      const error = new NeticApiError(res.status, body.error, this.tenant, path, hintFor(res.status, this.tenant), body.details, body.hint);
      if (res.status === 429 && attempt === 1 && retryAfter !== undefined && retryAfter <= 60) {
        await this.sleep(retryAfter * 1000);
        continue;
      }
      if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < this.maxAttempts) {
        await this.sleep(retryAfter !== undefined ? retryAfter * 1000 : backoffMs(attempt));
        continue;
      }
      throw error;
    }
  }

  get<T = unknown>(path: string, params: QueryParams = {}): Promise<T> {
    return this.request<T>("GET", path, params);
  }

  /** GET one page of a report endpoint and check the envelope. */
  async getPage(path: string, params: QueryParams): Promise<Envelope> {
    const body = await this.get<unknown>(path, params);
    if (!isEnvelope(body)) {
      throw new NeticApiError(200, "Response is not the {data, pagination} envelope the spec promises.", this.tenant, path, "");
    }
    return body;
  }
}

function backoffMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** (attempt - 1));
}
