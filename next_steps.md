# next_steps.md

Handoff state for HBSG-Netic-MCP.

**Last updated:** 2026-09-25 (pre-scaffold)

## START HERE (fresh session, 2026-09-25)

The plan is approved. Execute it, don't re-plan:
`C:\Users\justin.schmidt\.claude\plans\we-re-going-to-build-abstract-pike.md`

### Decisions already made (don't re-litigate)
- **Stack:** mirror `C:\Users\justin.schmidt\HBSG Searchlight MCP`: TypeScript, MCP SDK 1.x + zod, esbuild to `server/index.cjs`, vitest, `.mcpb` Desktop extension. Copy `schema-compat.ts` verbatim.
- **Rules files:** AGENTS.md is canonical. CLAUDE.md is Searchlight's 115-byte `@AGENTS.md` stub. This file is the handoff.
- **Tenants:** slugs `stl` (Hoffmann STL), `nash` (Hoffmann NSH), `blue` (Blue Sky) and `ferg` (Ferguson STL).
  - Every tool requires `tenant`, and there is **no silent default tenant** (this is the ServiceTitan rule).
  - `.env` uses `NETIC_TENANTS` + `NETIC_TENANT_<SLUG>_TOKEN`. The manifest uses slots `NETIC_TENANT_SLOT1..4_NAME/_TOKEN`.
- **Tokens:** Justin pastes the four bearer tokens into the gitignored `.env` himself. Don't ask for them in chat.
- **Tool catalog:** the 10 read-only tools listed in the plan (the `netic_*` prefix).
- **Git:** `git init -b main`, remote `https://github.com/HoffmannBros/HBSG-Netic-MCP.git` (empty on GitHub). Make logical commits and push to main.

### Source material (in this folder, not yet moved)
- `[External] OpenAPI.yaml` is the real spec: 6 GET endpoints, all under `/api/public/metrics/`. Move it to `docs/vendor/netic-openapi.yaml`.
- `[External] Intro to using Netic OpenAPI (1).docx` is the intro doc and adds nothing beyond the YAML. Move it to `docs/vendor/`.

### Traps already found
- **The same token authorizes `/api/public/metrics/web/leads`, which submits leads.** It is not in the spec. Stay GET-only and block that path, including in the raw tool and the probe.
- The docx says the `createdBefore` bound is ambiguous, but the spec settles it: **both bounds are inclusive**, in the tenant's local timezone.
- `calls/outbound` defaults to **CSV**. Always send `format=json`. Transcripts are huge, so `include_transcript` defaults to false.
- Row shapes vary by booking provider: ServiceTitan vs Cargas for TGL, and ServiceTitan vs session-based for scheduler bookings.
- The spec doesn't state a maximum date range. The probe needs to find it.
- There is no global `~/.claude/CLAUDE.md` on this machine. The per-repo AGENTS.md is the only written copy of the conventions.
- `gh` is not installed on this Windows machine.
