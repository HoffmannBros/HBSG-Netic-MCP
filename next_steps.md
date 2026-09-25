# next_steps.md

Handoff state for HBSG-Netic-MCP.

**Last updated:** 2026-09-25 (v0.1.0, probed and smoke-tested live on all four tenants)

## Goal

Claude Desktop extension (.mcpb) over the Netic Reports Export API: the read-only,
tenant-scoped JSON version of the Netic dashboard CSV exports, for four tenants (stl, nash,
blue, ferg). TypeScript on Node, bundled to one file with esbuild, mirroring
`HBSG Searchlight MCP`. Team members install the bundle and paste per-tenant tokens.

Approved plan: `~/.claude/plans/we-re-going-to-build-abstract-pike.md`.

## Where things stand

| Step | Status |
|---|---|
| Repo, scaffold, remote `HoffmannBros/HBSG-Netic-MCP` | done, pushed to `main` |
| Tenant config loader, GET-only client (web/leads blocked) | done |
| 10 read-only tools, server entry, schema compat | done |
| Tests (`npm test`) | 92 pass: unit, stdio handshake, every tool against a local fake API |
| `.env` with the four tokens | done (Justin pasted them; gitignored) |
| `npm run probe`, all four tenants | done 2026-09-25; findings in `docs/netic-api.md` |
| Drift fixes from the probe | done: default columns, scheduler-bookings 500 retry and hint |
| `npm run smoke`, all four tenants | **passed** 2026-09-25 |
| `npm run pack` | passes; `dist/hbsg-netic-0.1.0.mcpb` |
| Install the .mcpb in Claude Desktop and try it | not started (Justin double-clicks it) |
| Tag `v0.1.0` and GitHub Release | not started |

## Next actions, in order

1. Justin installs `dist/hbsg-netic-0.1.0.mcpb`, pastes the four tokens into the extension's
   settings, and asks something like "Blue Sky booked calls by lead source last week".
2. Fix anything found in real use, then tag `v0.1.0` and create the GitHub Release with the
   .mcpb attached (`gh` is installed).
3. Raise the scheduler-bookings timeouts with Netic (see "Verified facts").

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
- Global `core.autocrlf` is on; `.gitattributes` keeps `*.sh` LF so `pack.sh` runs.

## Decisions worth knowing

- `netic_get_*` put rows only in the text (a markdown table of default columns) and keep
  `structuredContent` to metadata, so a 500-row sample is not sent twice.
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
