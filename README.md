# Netic for Claude Desktop

A Claude Desktop extension that connects Claude to the Netic Reports Export API for Hoffmann
Brothers' brands. Netic runs the AI voice agent, texting, and online scheduler; this extension
reads the same rows as the Netic dashboard CSV exports: inbound interactions, scheduler
sessions and bookings, technician TGL and referrer bookings, outbound CSR calls, and the
Utilization Board.

It is read-only. It never creates leads or changes anything in Netic.

Works on Windows and macOS. Nothing to install besides Claude Desktop; the extension runs on
the Node runtime that ships with Claude.

## Install (team members)

1. Get `hbsg-netic-<version>.mcpb` from Justin or from the
   [Releases page](https://github.com/HoffmannBros/HBSG-Netic-MCP/releases).
2. Double-click the file (or drag it into Claude Desktop, Settings, Extensions). Click Install.
3. Fill in a token for each tenant you use. The names default to `stl` (Hoffmann STL), `nash`
   (Hoffmann NSH), `blue` (Blue Sky), and `ferg` (Ferguson STL). Leave unused slots blank.
   Tokens are stored in your operating system's keychain.
4. Optionally change the **Export folder** (default: `Documents/Netic Reports`).
5. Save. Start a new chat and try one of the prompts below.

Netic tokens are powerful: the same token can submit leads through a different Netic
endpoint. Treat them like passwords and never paste them into a chat.

### Try it

```
Blue Sky booked calls by lead source last week.
How many STL scheduler sessions were abandoned last month, and at which step?
Show me yesterday's Nashville inbound texts that didn't book.
Export all Ferguson call interactions for August to CSV.
What were the most common outbound call reasons for STL this week?
How booked is Blue Sky's HVAC Service group tomorrow, and how full was it at 8 AM yesterday?
Blue Sky % booked per business unit for last week.
Who bounced off the Blue Sky online scheduler yesterday and hasn't come back?
STL online scheduler bounces by Service and UTM source this month.
```

## What Claude can do

| Tool | Purpose |
|---|---|
| `netic_list_tenants` | Configured tenant names |
| `netic_get_interactions` | Inbound calls, texts, or recapture texts (pick a modality) |
| `netic_get_scheduler_sessions` | Online scheduler sessions, booked and abandoned, with the last step reached |
| `netic_get_scheduler_leads` | The dashboard's "online scheduler leads" export, plus repeat, rebooked, contacted-later, and recovered flags and a bounce summary |
| `netic_get_scheduler_bookings` | Jobs booked through the online scheduler, with UTMs and click ids |
| `netic_get_tgl_bookings` | Technician turn-the-lead bookings |
| `netic_get_referrer_bookings` | Referrer (RGL) bookings |
| `netic_get_outbound_calls` | Outbound CSR calls with summaries; transcripts on request |
| `netic_get_utilization` | Utilization Board: % booked per business unit and group per day, live or point in time |
| `netic_count` | Counts across every page, grouped by up to three columns; `aggregate=sum` totals utilization hours and recomputes % booked; `report=scheduler_leads` counts leads by any export column |
| `netic_export` | Every row of a report to a CSV or JSON file |
| `netic_api_call` | A Netic report path directly, GET only |

Every tool asks for a tenant; there is no default, so Claude asks if you did not say which
brand. Dates are inclusive on both ends in the tenant's local time. The `netic_get_*` tools
return a sample (500 rows by default) and end with a footer saying how many rows exist in
total; `netic_count` and `netic_export` cover every row.

Utilization reads like the Netic Utilization Board: each cell is "N jobs · X%", where X is job
hours over available hours (shift minus non-job hours). "No shifts" means no shift hours that
day, and over 100% means overbooked. Group rows (Blue Sky's HVAC Service group is the HVAC
Service and HVAC Maintenance units) already include their member units, so don't add the two.
Live is the default; a snapshot date (and optional time) is the board's Point in time. Netic
allows 31 days per request, and longer ranges are split automatically.

CSV files are UTF-8 with a byte-order mark and CRLF line endings, so Excel opens them cleanly
on Windows. Existing files are never overwritten; a numeric suffix is added instead.

## Maintainers

### Develop

```bash
npm install
npm test            # build + unit tests + stdio handshake + tools against a fake API
npm run inspect     # MCP Inspector against the built server
```

Copy `.env.example` to `.env` and paste the tenant tokens in. Then:

```bash
npm run probe       # check the spec against the live API, per tenant (GET only)
npm run smoke       # every tool against the live API through the built server
```

Raw probe and smoke output contains customer data. It lands in the gitignored `probe-output/`
and `smoke-output/` folders; only redacted shapes belong in `docs/netic-api.md`.

### Release

1. Bump `version` in `package.json`, `manifest.json`, and `src/version.ts` (they must match).
2. Run `npm run pack`. It builds, validates the manifest, packs, checks that the archive holds
   exactly `manifest.json`, `package.json`, `server/index.cjs`, `icon.png`, and `README.md`,
   scans for JWT-shaped strings and for every token in `.env`, and starts the bundle from a
   clean unpack.
3. Commit, tag, and attach the bundle to a GitHub Release:

   ```bash
   git tag v0.1.0 && git push --tags
   gh release create v0.1.0 dist/hbsg-netic-0.1.0.mcpb --title "v0.1.0"
   ```

### How it is built

TypeScript on Node with the MCP TypeScript SDK 1.x and Zod. esbuild bundles everything into
`server/index.cjs`, so the `.mcpb` ships no `node_modules`. See `AGENTS.md` for the layout
and the hard rules, and `docs/netic-api.md` for what the API actually does.
