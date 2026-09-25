# HBSG Netic MCP

## What this is

Claude Desktop extension (.mcpb) for the Netic Reports Export API: the read-only,
tenant-scoped JSON version of the Netic dashboard CSV exports (inbound interactions, TGL,
scheduler and referrer bookings, scheduler sessions, outbound CSR call transcripts). One
bearer JWT per tenant. TypeScript, Node, MCP SDK 1.x, bundled by esbuild into
`server/index.cjs` with no shipped node_modules.

## Session start

1. `git status --short --branch`, `git remote -v`, `git pull --ff-only`.
2. Read `next_steps.md` and verify what it claims before acting on it.
3. Update `next_steps.md` before ending the session.

## Commands

- `npm test` builds, then runs vitest (unit tests with mocked fetch plus a stdio handshake
  against the bundle).
- `npm run build` typechecks and bundles.
- `npm run probe` checks the spec against the live API for every tenant in `.env`. GET only.
  Raw responses go to the gitignored `probe-output/<date>/<tenant>/`.
- `npm run smoke` runs every tool against the live API through the built server.
- `npm run pack` builds, validates, packs `dist/hbsg-netic-<version>.mcpb`, checks the
  archive contents, scans for secrets, and runs the bundle from a clean unpack.
- `npm run inspect` opens the MCP Inspector against the built server.

## Layout

| Path | Role |
|---|---|
| `src/index.ts` | Server entry, `INSTRUCTIONS`, tool registration |
| `src/config.ts` | Tenant loader (`.env` style and manifest slots), path token expansion |
| `src/context.ts` | One client per tenant; `clientFor` refuses unknown tenants |
| `src/client.ts` | GET-only Netic client; path guard, preflight, hints, errors |
| `src/endpoints.ts` | The six report endpoints, their paths and default columns |
| `src/dates.ts` | Inclusive-range validation |
| `src/paging.ts` | Auto-paging over the `{data, pagination}` envelope |
| `src/rows.ts`, `src/aggregate.ts` | `where` filter, column choice, grouped counts |
| `src/csv.ts` | Streaming CSV and JSON export spool |
| `src/format.ts` | Markdown tables, the result footer, error text |
| `src/tools/*.ts` | tenants, reports, aggregate (count), export, raw |
| `src/schema-compat.ts` | Restamps tool schemas as JSON Schema 2020-12 |
| `scripts/probe.ts` | Live spec-versus-API checks |
| `scripts/smoke.ts`, `scripts/handshake.ts`, `scripts/pack.sh` | Live smoke, stdio check, bundle |
| `docs/vendor/` | Netic's OpenAPI spec and intro doc, as received |
| `docs/netic-api.md` | Spec summary plus dated live findings |

## Hard rules

- **GET only. Never touch `/api/public/metrics/web/leads`.** The same tenant token submits
  real leads into a live tenant. The client refuses any other method and that path, the raw
  tool refuses it, and the probe never calls it.
- **No silent default tenant.** Every tool requires `tenant`. An unknown tenant is an error
  that lists the configured names.
- Never commit, print, or paste tokens. `scripts/pack.sh` fails on a JWT-shaped string
  (`eyJ[\w-]{10,}\.`) and on any literal token from `.env`.
- Responses carry customer PII (names, phones, addresses, transcripts). `probe-output/` and
  `smoke-output/` stay gitignored; only redacted shapes go into `docs/`.
- stdout is the MCP transport. Log to stderr.
- Keep `version` identical in `package.json`, `manifest.json`, and `src/version.ts`.
- `src/schema-compat.ts` restamps every tool schema as JSON Schema 2020-12 on the way out of
  the transport. MCP SDK 1.x hardcodes draft-07 and Claude's client validates with Ajv 2020,
  which refuses draft-07. Do not remove it, and do not introduce `definitions` or
  `dependencies` into a tool schema; `tests/server.test.ts` enforces both.
- `docs/vendor/netic-openapi.yaml` is the vendor contract, but the dated "Live findings" in
  `docs/netic-api.md` win wherever they disagree.

## Gotchas

- Both date bounds (`createdOnOrAfter`, `createdBefore`) are inclusive, YYYY-MM-DD, in the
  tenant's local timezone. The name `createdBefore` suggests exclusive; it is not.
- Row shapes vary by booking provider: TGL is ServiceTitan or Cargas, scheduler bookings are
  ServiceTitan or session-based. Tenants without TGL or RGL return empty `data`.
- `date` on interactions is `MM/dd/yyyy HH:mm` local, not ISO.
- `calls/outbound` returns CSV unless `format=json`. The client always sends `format=json`.
  Transcripts are huge; `include_transcript` defaults to false.
- Scheduler session values are all strings, including counts and yes/no flags.
- Interactions carry 14 columns the spec omits (call durations, transfer and post-transfer
  outcome, `jobId`, `bookedByOther`); see "Live findings" in `docs/netic-api.md`.
- Scheduler bookings can take ~15 s and then 500 on a cold call; the client retries that one
  endpoint's 500s. Long ranges are fine everywhere; latency, not a limit, is the cost.

## Pointers

- Spec: `docs/vendor/netic-openapi.yaml`. Summary and live findings: `docs/netic-api.md`.
- Sibling repos with the same conventions: `HBSG Searchlight MCP` (stack, pack, schema
  compat) and the ServiceTitan MCP (multi-tenant rules).
