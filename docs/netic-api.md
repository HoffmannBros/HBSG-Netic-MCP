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

Keep this redacted: key names, types, counts, and statuses only. No names, phones, or
addresses.

### 2026-09-25, all four tenants (`npm run probe`, window 2026-09-18 to 2026-09-24)

**Auth and isolation.** All four tokens are HS256 JWTs with payload keys `tenant_id` and
`iat` and no `exp`. Each token returns only its own tenant; the row `tenant` field reads
`STL Hoffmann`, `NASH Hoffmann`, `Blue Sky`, and `Ferguson`. A missing token gets 401
`{"error":"Unauthorized"}`. (The first stl paste was one character short and got 401 on
everything; a JWT signature that decodes to 31 bytes instead of 32 is the tell.)

**Envelope.** Exactly as specified on every endpoint: `data` plus `pagination` with number
`page`, `pageSize`, `totalRecords`, `totalPages` and boolean `hasMore`.

**Inclusive bounds: confirmed.** For every tenant, seven single-day totals sum exactly to the
seven-day total (stl 3471, nash 818, blue 1531, ferg 373 calls), and a single-day pull holds
only that day's rows by the `date` field.

**No maximum range.** 31, 92, 366, and 731 days all return 200 on interactions. Latency grows
with range even at pageSize 1: stl took 4 s, 20 s, 61 s, and 28 s. The 120 s client timeout
covers it.

**pageSize.** 5000 works; 5001 and 0 get 400. A 5000-row page takes about 0.8 s.

**Errors.** 400 bodies are `{error: "Invalid query parameters", details: [{field, message}],
hint}`; `hint` restates the expected parameters. An end date before the start date is *not*
an error: it returns 200 with no rows (the client refuses it locally anyway).

**Outbound default.** With no `format`, the response is `text/csv; charset=utf-8` with header
`id,service_titan_call_id,job_id,tenant,call_placed_at,call_duration_seconds,agent_id,agent_name,customer_phone,call_type,call_reason,summary,transcript,analysis`.
JSON rows carry the same keys, matching the spec.

**Row drift from the spec.**
- Interactions carry 14 undocumented columns on every tenant: `callDurationAi`,
  `callDurationHuman`, `callDurationTotal` (strings or null), `jobId`, `transferredTo`,
  `transferNumber`, `transferAnswered`, `postTransferOutcome`, `postTransferReason`,
  `postTransferSubReason`, `postTransferJobId`, `postTransferJobType`, `bookedByOther`
  (boolean), and `bookedByOtherJobId`. No spec column is missing. Row `modality` is `Call` or
  `Text`, as specified.
- Scheduler sessions carry more than the description names: `session_created_at`,
  `session_source`, `device_type`, `id`, `updated_at`, `job_type_id`, and full customer PII
  (`customer_name`, `customer_phone_number`, `customer_email`, address, `customer_id`,
  `location_id`). All values are strings. `status` is `completed` or `abandoned`, and
  `completed` sessions have `last_step` `booked` (stl: 689 completed against 696 scheduler
  bookings for the week).
- TGL, scheduler bookings, referrer, and outbound rows match the spec exactly.

**Variants.** Every tenant is ServiceTitan. TGL rows: stl 143, nash 28, blue 39, ferg 0 for
the week. Scheduler bookings are the ServiceTitan shape everywhere. Referrer bookings: stl
0 for the week (7 in 90 days), nash 0, blue 0, ferg 3. Outbound calls: stl 3, nash 693,
blue 757, ferg 0.

**Scheduler bookings are slow and flaky.** On cold calls the endpoint took 9 to 16 s per
request *regardless of range* (stl ran 31 days in 9.4 s), and Netic answered 500
`Failed to fetch scheduler booked jobs` whenever a request passed about 15 s. It hit every
tenant at some point, and nash failed 7 times in a row. Retries often land, and after a
warm-up the same queries answer in 0.4 to 2.3 s on every tenant. The client therefore
retries a 500 on this one endpoint (3 attempts); other 500s are not retried. Worth raising
with Netic.

### 2026-09-25, utilization (`/api/public/metrics/utilization`, not in the vendor spec)

Probed by hand on blue, then `npm run probe` on all four tenants. UI comparison and the
parity table are in `docs/utilization-ui-findings.md`.

- **Params.** `startDate` and `endDate` (YYYY-MM-DD, both inclusive, required),
  `snapshotDate`, `snapshotTime`, `page`, `pageSize` (max 5000). It rejects
  `createdOnOrAfter`/`createdBefore` with 400 `startDate: Required; endDate: Required`.
  Netic's own 400 hint lists the params.
- **Range.** 31 inclusive days (start + 30) returns 200; 32 returns 400 `endDate: range may
  span at most 31 days`, despite the hint's wording "at most 31 days after startDate". End
  before start is a 400 here, unlike the other endpoints. Future dates are fine (live).
  One 31-day request took about 1.5 s on blue.
- **Snapshot.** `snapshotDate` alone means the end of that day: `snapshotAt:
  "2026-09-24T23:59:59.999-06:00"`. With `snapshotTime=08:00`, `snapshotAt:
  "2026-09-23T08:00:00.000-06:00"`. `snapshotTime` alone is 400 `snapshotTime: requires
  snapshotDate`; a future `snapshotDate` is 400 `has not started yet in the tenant's
  timezone`. Live responses carry `snapshotAt: null`.
- **Envelope.** `{data, pagination, timeZone, snapshotAt}`. `timeZone` is America/Denver
  for blue and America/Chicago for stl, nash, and ferg.
- **Rows.** One per business unit or group per day, every day (weekends included):
  `{date, type: "group"|"business_unit", name, businessUnitId (null on groups), groups
  (a unit's group names; [] on groups), percentBooked, jobHours, shiftHours, nonJobHours,
  availableHours, jobs}`. Rows per day: blue 14, stl 22, nash 20, ferg 16. No customer PII.
- **percentBooked** = round(jobHours / availableHours × 100), availableHours = shiftHours −
  nonJobHours, computed from unrounded hours (recomputing from the 0.1-hour values is off by
  a point on about 3% of rows). null when shiftHours is 0 (the board's "No shifts"), and 0
  when there are shifts but no available hours, even with jobs.
- **Groups.** A group's hours equal the sum of its member units (blue's HVAC Service group =
  HVAC Service + HVAC Maintenance on 9/24: 87.8 job hours / 88.9 available = 99%, 37 jobs).
  The member units list it in `groups`.
- `type` and `name` query params are ignored (all 14 rows came back with `type=group`).
- Blue has a unit named `"HVAC Sales "` with a trailing space.
- `npm run probe` confirmed every point above on all four tenants: the same row keys (no
  drift), 31 days 200 and 32 days 400, the snapshot errors, and the created-param refusal.
  Group rows per day: stl 2, nash 4, blue 1, ferg 8. The same run hit the known
  scheduler-bookings 500 on stl and nash, which is unrelated.
