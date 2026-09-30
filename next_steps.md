# next_steps.md

Handoff state for HBSG-Netic-MCP.

**Last updated:** 2026-09-30 (v0.3.0 released: online scheduler leads, verified live, installed
in Claude Desktop and working)

## Goal

Claude Desktop extension (.mcpb) over the Netic Reports Export API: the read-only,
tenant-scoped JSON version of the Netic dashboard CSV exports, for four tenants (stl, nash,
blue, ferg). TypeScript on Node, bundled to one file with esbuild, mirroring
`HBSG Searchlight MCP`. Team members install the bundle and paste per-tenant tokens.

Plans: `~/.claude/plans/we-re-going-to-build-abstract-pike.md` (v0.1.0) and
`~/.claude/plans/pasted-content-id-2a3f-add-support-wiggly-bunny.md` (v0.2.0 utilization and
inline rows; done), `~/.claude/plans/c-users-justin-schmidt-downloads-online-foamy-squid.md`
(v0.3.0 online scheduler leads; done).

## Where things stand

| Step | Status |
|---|---|
| Repo, scaffold, remote `HoffmannBros/HBSG-Netic-MCP` | done, pushed to `main` |
| Tenant config loader, GET-only client (web/leads blocked) | done |
| 12 read-only tools, server entry, schema compat | done (v0.2.0 added `netic_get_utilization`, v0.3.0 `netic_get_scheduler_leads`) |
| Tests (`npm test`) | 134 pass: unit, stdio handshake, every tool against a local fake API |
| Online scheduler leads: tool, `report=scheduler_leads` in count and export | done 2026-09-30; 807 of 807 rows and all 15 columns match the dashboard CSV (blue, 8/30 to 9/30) |
| Rows missing from tool results (only `structuredContent` reaches the model) | fixed in v0.2.0: rows now in `structuredContent` for get, api_call, and export preview |
| Utilization: tool, `netic_count aggregate=sum`, export, api_call docs | done; 70 of 70 UI cells match (`docs/utilization-ui-findings.md`) |
| `.env` with the four tokens | done (Justin pasted them; gitignored) |
| `npm run probe`, all four tenants | done 2026-09-25; findings in `docs/netic-api.md` |
| Drift fixes from the probe | done: default columns, scheduler-bookings 500 retry and hint |
| `npm run smoke`, all four tenants | **passed** 2026-09-30 (ferg's 45-day utilization call got one Netic 500 at 15 s; the rerun passed) |
| `npm run pack` | passes; `dist/hbsg-netic-0.3.0.mcpb` |
| Install the .mcpb in Claude Desktop and try it | done 2026-09-29: installed over v0.1.0, works, rows inline |
| Install v0.3.0 in Claude Desktop | done 2026-09-30: installed over v0.2.0, both test questions answered correctly |
| Tag and GitHub Release | done: `v0.3.0` 2026-09-30 (`v0.2.0` before it; v0.1.0 was never released) |

## Next actions, in order

1. Share the release with the team:
   https://github.com/HoffmannBros/HBSG-Netic-MCP/releases/tag/v0.3.0 (v0.2.0 was never
   announced either).
2. Build the Cowork daily bounced digest on top of `netic_get_scheduler_leads` (`booked=no,
   exclude_recovered=true, start=end=yesterday`).
3. Raise the scheduler-bookings timeouts with Netic (see "Verified facts").
4. Anything from "Ideas not built" only when someone asks for it.

## Verified facts (live 2026-09-25 unless noted)

- Both date bounds are inclusive; single-day totals sum exactly to the week on all tenants.
- No maximum date range: 731 days returns 200. Latency grows with range (stl interactions
  at pageSize 1: 31 d 4 s, 92 d 20 s, 366 d 61 s). So no range chunking was built.
- pageSize 5001 and 0 get 400. End before start gets 200 with no rows, not an error.
- Scheduler bookings: 9 to 16 s per cold request regardless of range, and a 500 past about
  15 s. A retry often lands, and warm calls answer in under 2.5 s. The client retries 500s
  on that endpoint only.
- Every tenant is ServiceTitan (TGL and scheduler-bookings shapes). Ferguson has no TGL or
  outbound calls; only Ferguson and STL have referrer bookings.
- Row `tenant` values: `STL Hoffmann`, `NASH Hoffmann`, `Blue Sky`, `Ferguson`.
- Tokens are HS256 JWTs with `tenant_id` and `iat` and no expiry. A signature that decodes
  to 31 bytes instead of 32 means a truncated paste (it happened with stl).
- `gh` is installed on this Windows machine (`C:\Program Files\GitHub CLI\gh.exe`).
- Utilization (not in the vendor spec): `startDate`/`endDate`, 31 inclusive days max,
  `snapshotDate` alone means 23:59:59.999 local, `snapshotTime` without a date is a 400, a
  future snapshot date is a 400, end before start is a 400. Envelope adds `timeZone`
  (America/Denver for blue, America/Chicago for stl, nash, ferg) and `snapshotAt`. Rows per
  day: blue 14, stl 22, nash 20, ferg 16. Full detail in `docs/netic-api.md` and
  `docs/utilization-ui-findings.md`.
- The Utilization Board UI calls an internal `/api/dashboard/capacity/utilization-board`,
  not the public endpoint, but the values agree cell for cell.
- Online scheduler leads (2026-09-30): the dashboard export is `scheduler/sessions` with a
  phone or street address; mapping and parity in `docs/netic-api.md`. Last Known Step is not
  in the public API. Values are untrimmed in the export (trailing spaces in City).
- `netic_get_interactions` with a narrow `where` over a month walks 100-row pages and can pass
  the MCP client's 60 s timeout; `netic_export` with the same `where` uses 5000-row pages.
- Global `core.autocrlf` is on; `.gitattributes` keeps `*.sh` LF so `pack.sh` runs.

## Decisions worth knowing

- `netic_get_*` put rows in both the text (a markdown table) and `structuredContent.rows`
  (projected to the shown columns). v0.1.0 kept rows out of `structuredContent` to avoid
  sending them twice, but Claude's client then shows the model only the structured object,
  so the rows never arrived. `netic_api_call` returns `rows` (envelopes) or `body` (other JSON
  up to 20k characters), and `netic_export` returns a 5-row `preview`.
- Utilization: `board` is a derived column, "N jobs · X%" or "N jobs · No shifts", so answers
  match what people see in Netic. `type` and `name` filter client-side (the API ignores them).
  Ranges over 31 days split into consecutive 31-day requests with a dedupe safeguard;
  `page` with a split range is refused. `aggregate=sum` recomputes % from summed hours (a
  single row keeps Netic's own value, which is computed from unrounded hours) and warns when
  group and unit rows are mixed.
- A snapshot date is refused locally only when it is in the future everywhere (after today in
  UTC+14); nearer cases are left to Netic, which knows the tenant timezone.
- Interaction default columns now include `postTransferOutcome`, `jobId`, and
  `callDurationTotal` (undocumented but present everywhere). Session defaults use
  `session_created_at`, `session_source`, and `device_type`.
- A `where` equality filter (client-side) is on the get, count, and export tools. The
  sessions tool also takes `status` and `last_step`, which map onto it.
- `netic_export` keeps outbound transcripts by default (they go to a file);
  `netic_get_outbound_calls` drops them by default.
- The probe's deliberately invalid calls bypass the client preflight through `rawGet`, which
  accepts only the six report paths. The day's `summary.json` merges per tenant, so
  `npm run probe -- stl` keeps the other tenants' results.
- Scheduler leads: `booked_later` and `contacted_later` count only within `repeat_window_days`
  (default 7) of each session, so a lead's flags do not depend on how long a range was asked
  for. The plan only widened the fetch; the per-lead cap was added after a hand check found a
  first contact 16 days out being counted in a month-long pull. Contacts match by phone only
  (interactions carry no address), at or after the session's minute. `recovered` = booked
  later, or the contact has a job id or category Booked.
- Scheduler leads results carry a `followUp` block in `structuredContent` (contactsChecked,
  window, windowStillOpen, and a caveat line), since the footer notes never reach the model.
  The tool description and `INSTRUCTIONS` tell the agent to relay the caveat when it matters.
- Range windowing was tried for scheduler bookings and backed out: latency does not depend on
  range there, so splitting only multiplies slow calls.

## Ideas not built (YAGNI until asked)

- Incremental sync using the `updatedAt` and `postTransferUpdatedAt` watermarks (booked-later
  reconciliation moves the second one, not the first).
- Joining to ServiceTitan by job id or call id (the ServiceTitan MCP is a sibling).
- Date bucketing in `netic_count` (group by day, week, or month); dates differ per endpoint
  (`MM/dd/yyyy HH:mm` on interactions, ISO elsewhere).
- Adding the 14 undocumented interaction columns to `scripts/spec-keys.ts` so the probe
  reports only new drift.
- CSV formula-injection guard: phone numbers start with `+`, so Excel may read them as
  numbers. Not changed, since escaping would alter the data for other consumers.
- Board screenshots in `docs/img/`: the plan asked for them, but Chrome's screen capture timed
  out repeatedly on 2026-09-25, so the UI values were recorded as text instead.
- Exact `totalRecords` when a split utilization range stops early at `max_rows`: the footer
  says it covers only the windows walked. A `pageSize=1` call per remaining window would make
  it exact if anyone needs it.
- Shift warnings (`/api/dashboard/utilization/shift-warnings`) and saved views exist only in
  the internal dashboard API, which a tenant token does not reach.
