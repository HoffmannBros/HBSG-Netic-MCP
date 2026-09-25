# Netic Reports Export API

Summary of `docs/vendor/netic-openapi.yaml` (OpenAPI 3.0.3, v1.0.0, received 2026-09-25),
followed by dated live findings from `npm run probe`. Where they disagree, the live findings
win.

## From the spec

- Base URL `https://app.netic.ai`. Every request sends `Authorization: Bearer <tenant JWT>`.
  Tokens are tenant-scoped and come from Netic onboarding.
- **The same token authorizes `/api/public/metrics/web/leads`, which submits leads.** That
  endpoint is not in the spec. The MCP refuses every path under `/api/public/metrics/web`.
- All six report endpoints are `GET`. Each requires `createdOnOrAfter` and `createdBefore`
  (YYYY-MM-DD, **both inclusive**, tenant local timezone) and takes optional `page` (1-based,
  default 1) and `pageSize` (1 to 5000, default 100).
- Success is always `{ data: [...], pagination: { page, pageSize, totalRecords, totalPages,
  hasMore } }`.
- Errors are `{ error, message?, details?: [{ field, message }], hint? }` with status 400
  (bad parameters), 401 (missing or bad token), or 500.
- The spec states no maximum date range and no rate limit.

| Endpoint | Extra params | Rows |
|---|---|---|
| `/api/public/metrics/interactions` | `modality` (required): `call`, `inbound_text`, `recapture_text` | One per inbound interaction. `date` is `MM/dd/yyyy HH:mm` local. Row `modality` (`Call`/`Text`) is the outcome channel, not the request filter. `updatedAt` and `postTransferUpdatedAt` are incremental-sync watermarks. ServiceTitan fields are null for non-ServiceTitan tenants. |
| `/api/public/metrics/bookings/technician-tgl` | none | ServiceTitan or Cargas shape. Empty for tenants without TGL. |
| `/api/public/metrics/bookings/scheduler` | none | ServiceTitan or session-based shape. UTMs, click ids, landing page. |
| `/api/public/metrics/scheduler/sessions` | none | Booked and abandoned sessions. Every value is a string. `status`, `last_step`, `booked_from` (`rwg`/`website`), `blocker_type`/`blocker_detail`, `marketing_source`, attribution. |
| `/api/public/metrics/bookings/referrer` | none | RGL bookings. Empty for tenants without RGL. |
| `/api/public/metrics/calls/outbound` | `format` (`csv` default, `json`), `agentId` (comma-separated ST agent ids) | Human CSR calls: summary, transcript (large), analysis (JSON string, empty for now). All values strings. |

The intro docx (`docs/vendor/netic-openapi-intro.docx`) flags `createdBefore` as possibly
exclusive; the spec says inclusive, and the probe checks it.

## Live findings

Not yet run. `npm run probe` fills this in once the tenant tokens are in `.env`. Record, per
tenant and dated:

- which endpoints return 200 and any envelope or row-key drift from the spec;
- the TGL and scheduler-booking variant (ServiceTitan, Cargas, session-based, or empty);
- whether seven single-day totals sum to the seven-day total, and whether a single-day pull
  holds only that day's rows (inclusive bounds);
- the largest date range accepted (31, 92, 366, 731 days tried) and its latency;
- the pageSize 5000/5001 boundary and the error shapes for bad modality, missing date, end
  before start, and no token;
- the outbound default content type and CSV header;
- the `tenant` values seen in rows (isolation).

Keep this redacted: key names, types, counts, and statuses only. No names, phones, or
addresses.
