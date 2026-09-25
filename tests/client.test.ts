import { describe, expect, it } from "vitest";
import { DateError } from "../src/dates.js";
import { NeticApiError, NeticClient, NeticRequestError, assertAllowedPath, type ClientOptions } from "../src/client.js";

interface Call {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function makeClient(handler: (url: string) => Response, overrides: Partial<ClientOptions> = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url);
  }) as typeof fetch;
  const client = new NeticClient({
    tenant: "stl",
    token: "tok-123",
    baseUrl: "https://example.test",
    timeoutMs: 1000,
    fetchImpl,
    sleep: async () => {},
    ...overrides,
  });
  return { client, calls };
}

const envelope = (data: unknown[], extra: Partial<{ page: number; hasMore: boolean; totalRecords: number }> = {}) => ({
  data,
  pagination: { page: 1, pageSize: 100, totalRecords: data.length, totalPages: 1, hasMore: false, ...extra },
});

const range = { createdOnOrAfter: "2026-09-01", createdBefore: "2026-09-07" };

describe("assertAllowedPath", () => {
  it("allows the report endpoints", () => {
    expect(() => assertAllowedPath("/api/public/metrics/interactions")).not.toThrow();
    expect(() => assertAllowedPath("/api/public/metrics/bookings/technician-tgl")).not.toThrow();
  });

  it.each([
    "/api/public/metrics/web/leads",
    "/api/public/metrics/WEB/Leads",
    "/api/public/metrics/web",
    "/api/public/metrics/web/leads/",
    "/api/public/metrics/x/../web/leads",
    "/api/public/metrics//web/leads",
    "/api/public/metrics/%77eb/leads",
    "/api/public/metrics/interactions?x=/web/leads",
    "/api/public/metrics\\web\\leads",
    "/api/private/anything",
    "https://evil.test/api/public/metrics/interactions",
  ])("refuses %s", (path) => {
    expect(() => assertAllowedPath(path)).toThrow(NeticRequestError);
  });
});

describe("NeticClient", () => {
  it("sends a bearer GET with the params and returns the envelope", async () => {
    const { client, calls } = makeClient(() => jsonResponse(envelope([{ id: "a" }])));
    const page = await client.getPage("/api/public/metrics/bookings/referrer", { ...range, page: 1, pageSize: 50 });
    expect(page.data).toEqual([{ id: "a" }]);
    expect(calls[0]?.url).toBe(
      "https://example.test/api/public/metrics/bookings/referrer?createdOnOrAfter=2026-09-01&createdBefore=2026-09-07&page=1&pageSize=50",
    );
    expect(calls[0]?.init.method).toBe("GET");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
  });

  it("refuses every method but GET without sending anything", async () => {
    const { client, calls } = makeClient(() => jsonResponse({}));
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await expect(client.request(method, "/api/public/metrics/interactions", range)).rejects.toThrow(/GET only/);
    }
    expect(calls).toHaveLength(0);
  });

  it("never sends a request to web/leads", async () => {
    const { client, calls } = makeClient(() => jsonResponse({}));
    await expect(client.get("/api/public/metrics/web/leads")).rejects.toThrow(/web-leads/);
    expect(calls).toHaveLength(0);
  });

  it("forces format=json on outbound calls", async () => {
    const { client, calls } = makeClient(() => jsonResponse(envelope([])));
    await client.getPage("/api/public/metrics/calls/outbound", { ...range, format: "csv", agentId: "1,2" });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("agentId")).toBe("1,2");
  });

  it.each([
    [{ createdOnOrAfter: "2026-09-01" }, /createdBefore/],
    [{ createdBefore: "2026-09-01" }, /createdOnOrAfter/],
    [{ createdOnOrAfter: "2026-02-30", createdBefore: "2026-03-01" }, /not a real date/],
    [{ createdOnOrAfter: "09/01/2026", createdBefore: "2026-09-02" }, /not a real date/],
    [{ createdOnOrAfter: "2026-09-08", createdBefore: "2026-09-07" }, /before start/],
  ])("refuses a bad range %j before sending", async (params, pattern) => {
    const { client, calls } = makeClient(() => jsonResponse(envelope([])));
    const err = await client.get("/api/public/metrics/bookings/scheduler", params).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DateError);
    expect((err as Error).message).toMatch(pattern);
    expect(calls).toHaveLength(0);
  });

  it("accepts a single-day range, since both bounds are inclusive", async () => {
    const { client } = makeClient(() => jsonResponse(envelope([])));
    await expect(client.get("/api/public/metrics/bookings/scheduler", { createdOnOrAfter: "2026-09-01", createdBefore: "2026-09-01" })).resolves.toBeTruthy();
  });

  it.each([0, 5001, 2.5, "abc"])("refuses pageSize %s", async (pageSize) => {
    const { client, calls } = makeClient(() => jsonResponse(envelope([])));
    await expect(client.get("/api/public/metrics/bookings/scheduler", { ...range, pageSize })).rejects.toThrow(/pageSize/);
    expect(calls).toHaveLength(0);
  });

  it("requires a valid modality on interactions", async () => {
    const { client, calls } = makeClient(() => jsonResponse(envelope([])));
    await expect(client.get("/api/public/metrics/interactions", range)).rejects.toThrow(/modality/);
    await expect(client.get("/api/public/metrics/interactions", { ...range, modality: "email" })).rejects.toThrow(/modality/);
    expect(calls).toHaveLength(0);
    await client.get("/api/public/metrics/interactions", { ...range, modality: "call" });
    expect(calls).toHaveLength(1);
  });

  it("surfaces a 400 with Netic's details and hint", async () => {
    const { client } = makeClient(() =>
      jsonResponse(
        { error: "Invalid query parameters", details: [{ field: "createdOnOrAfter", message: "Required" }], hint: "Use YYYY-MM-DD" },
        400,
      ),
    );
    const err = (await client.get("/api/public/metrics/bookings/referrer", range).catch((e: unknown) => e)) as NeticApiError;
    expect(err).toBeInstanceOf(NeticApiError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("createdOnOrAfter: Required");
    expect(err.message).toContain("Use YYYY-MM-DD");
  });

  it("names the tenant on a 401 and never echoes the token", async () => {
    const { client } = makeClient(() => jsonResponse({ error: "Unauthorized" }, 401));
    const err = (await client.get("/api/public/metrics/bookings/referrer", range).catch((e: unknown) => e)) as NeticApiError;
    expect(err.message).toMatch(/tenant "stl"/);
    expect(err.message).toMatch(/NETIC_TENANT_STL_TOKEN/);
    expect(err.message).not.toContain("tok-123");
  });

  it("retries a 503 and then succeeds", async () => {
    let n = 0;
    const { client, calls } = makeClient(() => (++n === 1 ? jsonResponse({ error: "busy" }, 503) : jsonResponse(envelope([]))));
    await client.get("/api/public/metrics/bookings/referrer", range);
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 500", async () => {
    const { client, calls } = makeClient(() => jsonResponse({ error: "boom" }, 500));
    await expect(client.get("/api/public/metrics/bookings/referrer", range)).rejects.toThrow(/500/);
    expect(calls).toHaveLength(1);
  });

  it("rejects a non-JSON success, such as a CSV body", async () => {
    const { client } = makeClient(() => new Response("id,tenant\n1,x", { status: 200, headers: { "content-type": "text/csv" } }));
    await expect(client.get("/api/public/metrics/bookings/referrer", range)).rejects.toThrow(/Expected JSON/);
  });

  it("rejects a body that is not the envelope", async () => {
    const { client } = makeClient(() => jsonResponse([{ id: 1 }]));
    await expect(client.getPage("/api/public/metrics/bookings/referrer", range)).rejects.toThrow(/envelope/);
  });
});
