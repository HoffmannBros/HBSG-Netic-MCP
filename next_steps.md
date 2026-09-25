# next_steps.md

Handoff state for HBSG-Netic-MCP.

**Last updated:** 2026-09-25 (v0.1.0 built, not yet probed live)

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
| Tests (`npm test`) | 91 pass: unit, stdio handshake, every tool against a local fake API |
| Probe and smoke scripts | written; probe dry-run against a local fake server works |
| manifest.json (v0.4, 4 tenant slots), README, `scripts/pack.sh` | done |
| `npm run pack` | passes; `dist/hbsg-netic-0.1.0.mcpb`, 272 KB, handshake ~210 ms |
| `.env` with the four tokens | **not started: Justin pastes them himself** |
| `npm run probe` against live tenants | not started (needs tokens) |
| Record live findings in `docs/netic-api.md`, fix any drift | not started |
| `npm run smoke` against a live tenant | not started (needs tokens) |
| Install the .mcpb in Claude Desktop and try it | not started |
| Tag and GitHub Release | not started |

## Next actions, in order

1. `cp .env.example .env`, then Justin pastes the four tokens into `.env`. Never through chat.
2. `npm run probe` (or `npm run probe -- stl` for one tenant). Read the console summary
   (shapes only; raw rows are in `probe-output/<date>/<tenant>/`).
3. Record the dated, redacted findings in `docs/netic-api.md` "Live findings" and in
   "Verified facts" below. Fix any drift:
   - if a maximum date range exists, split long ranges into chunks in `src/paging.ts`
     (plan: the client splits long ranges);
   - if row keys differ from the spec, update `src/endpoints.ts` default columns and
     `scripts/spec-keys.ts`;
   - if the inclusive-bounds check fails, fix the `endArg` description and AGENTS.md.
4. `npm run smoke -- <tenant>` for each tenant, then `npm run pack`.
5. Justin installs `dist/hbsg-netic-0.1.0.mcpb` and asks something like "Blue Sky booked calls
   by lead source last week".
6. Tag `v0.1.0` and create the GitHub Release with the .mcpb attached.

## Verified facts

- The remote was empty before the first push (2026-09-25).
- `gh` **is** installed on this Windows machine (`C:\Program Files\GitHub CLI\gh.exe`); the
  earlier handoff said otherwise.
- Global `core.autocrlf` is on; `.gitattributes` keeps `*.sh` LF so `pack.sh` runs.
- The spec settles `createdBefore` as inclusive; the live check is pending.

## Decisions worth knowing

- `netic_get_*` put rows only in the text (a markdown table of default columns) and keep
  `structuredContent` to metadata, so a 500-row sample is not sent twice.
- A `where` equality filter (client-side) is on the get, count, and export tools. The
  sessions tool also takes `status` and `last_step`, which map onto it.
- `netic_export` keeps outbound transcripts by default (they go to a file);
  `netic_get_outbound_calls` drops them by default.
- The probe's deliberately invalid calls (pageSize 5001, bad modality, no token) bypass the
  client preflight through `rawGet`, which accepts only the six report paths.
- Tenant labels (Hoffmann STL, Hoffmann NSH, Blue Sky, Ferguson STL) live in
  `src/tools/common.ts` and in the tenant argument's description.

## Ideas not built (YAGNI until asked)

- Incremental sync using the `updatedAt` and `postTransferUpdatedAt` watermarks (booked-later
  reconciliation moves the second one, not the first).
- Joining to ServiceTitan by job id or call id (the ServiceTitan MCP is a sibling).
- Date bucketing in `netic_count` (group by day, week, or month); dates differ per endpoint
  (`MM/dd/yyyy HH:mm` on interactions, ISO elsewhere).
- CSV formula-injection guard: phone numbers start with `+`, so Excel may read them as
  numbers. Not changed, since escaping would alter the data for other consumers.
