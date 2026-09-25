# Utilization Board: UI findings and parity

Inspected 2026-09-25 on `https://hoffmann.netic.ai/dashboard/utilization/board`, tenant
**Blue Sky** (America/Denver), with the dashboard's own network calls captured. Compared
against the public API (`GET /api/public/metrics/utilization`) and against
`netic_get_utilization` through the built server. No screenshots are committed: Chrome's
screen capture kept timing out on this machine, so the values below were read from the
rendered page text instead.

## What the board is

- **Utilization > Board**, titled "Utilization Board". Rows are business units, with groups
  shown as a parent row. Columns are days. There are no technician, zone, or trade rows.
- Each cell is **"N jobs · X%"** over a colored fill bar. Values over 100% are shown as they
  are (106%, 139%, 197%, 217%). **"0%"** means there are shifts but nothing booked (or no
  time left after non-job hours). **"No shifts"** means no shift hours that day, even when
  jobs exist (Blue Sky's HVAC Maintenance unit carries jobs with 0 shift hours every day).
- **% = job hours ÷ (shift hours − non-job hours), rounded.** Checked against 2,232 live rows
  on all four tenants (2026-08-26 to 2026-09-25): every row matches, except that Netic rounds
  from unrounded hours, so recomputing from the API's 0.1-hour figures can be off by a point
  (STL Appliance Install shows 228 where 16.8 ÷ 7.4 gives 227). With shifts but 0 available
  hours, the value is 0 even when jobs exist.
- **Groups**: the HVAC Service row's info icon reads "Business units in this group: HVAC
  Service, HVAC Maintenance." Group hours equal the sum of their members. A group is not
  additive with its members.
- **Live** ("Showing utilization as it stands right now.") starts at Today and shows 3, 5, or
  10 days forward. It never shows past days.
- **Point in time** has a date picker, a time picker (hourly, in MDT, up to now for today),
  "Use end of day", and "Back to live". The banner reads roughly: viewing the board as it
  stood at that moment; only shifts and jobs that existed by then count, and later bookings,
  cancellations, and edits are not reflected. Columns start at the snapshot date.
- **Gear button** opens Settings > Utilization, which configures booking caps and scenarios
  (e.g. 75% per scenario per day) and the Flexible or Strict capacity mode. Those are rules
  applied on top of capacity, not board values. Its "How is this calculated?" says capacity
  comes from FSM technician schedules, shifts, booked jobs, and non-job appointments.
- **Utilization > Management** is a separate slot-availability tool filtered by job type,
  business unit, zones, and tags. It is not the board.
- Also on the board: saved views ("Default", plus a pencil for "Create a view from the
  default groups"), a business-unit checklist with the group as parent of its units, a
  download button, and the 3/5/10-day toggle.

## Network

- The board calls an internal endpoint, not the public one:
  `GET /api/dashboard/capacity/utilization-board?dayCount={3|5|10}`, plus
  `&snapshotDate=YYYY-MM-DD&snapshotTime=HH:mm` in Point in time.
- **"Use end of day" sends `snapshotDate` alone, with no `snapshotTime`.** The public API
  reads a date alone as `23:59:59.999` local (`snapshotAt: "2026-09-24T23:59:59.999-06:00"`),
  so the two agree.
- Internal shape: `{days:[{date, businessUnits:[{businessUnitId, businessUnitName,
  jobsBooked, totalCapacity, percentBooked, jobHours, shiftHours, nonJobHours}]}],
  businessUnits, groupDefinitions:[{name, businessUnitIds}], startFromTomorrow, timeZone,
  tenantToday, snapshotAt}`. It also calls `/api/dashboard/utilization/shift-warnings`.

## Discrepancies between the UI and the API notes, and what was done

| # | Finding | Effect on the build |
|---|---|---|
| 1 | The internal payload has no group rows; the UI builds groups from `groupDefinitions`. The public API returns group rows (`type: "group"`, `businessUnitId: null`, `groups: []`), and member units list their group in `groups`. | The tool returns the API's group rows, and descriptions warn that groups are not additive with members. |
| 2 | "No shifts": the internal payload sends `percentBooked: 0` and the UI shows "No shifts"; the public API sends `null`. | A `board` column renders null as "No shifts"; `aggregate=sum` shows it the same way. |
| 3 | `totalCapacity` (about shiftHours ÷ 2) and `jobsBooked` are internal only. The public API has `jobs` and `availableHours` and no capacity field. | Not exposed. |
| 4 | Blue Sky's unit is named `"HVAC Sales "` with a trailing space. | The `name` filter trims and ignores case. |
| 5 | Live never renders past days; the public API returns any date, past or future, live. | Descriptions say Live works for any date; the UI needs Point in time to show a past day. |
| 6 | Notes said `endDate` is "at most 31 days after startDate". Live, 31 inclusive days (start + 30) is accepted and 32 is a 400 ("range may span at most 31 days"). | `maxRangeDays: 31`; longer ranges split into 31-day requests. |
| 7 | `type` and `name` query params are ignored by the API (it returned all 14 rows with `type=group`). | Both are client-side filters. |
| 8 | End before start is a 400 on utilization (the other endpoints return 200 with no rows). | Preflight refuses it either way. |
| 9 | The formula has a third case the notes missed: shifts but 0 available gives 0, not null. | `percentBooked()` follows it; see above. |

## Parity table

Tool values come from `netic_get_utilization` (tenant blue, the `board` column), run
2026-09-25 about 16:20 MDT. UI values were read from the rendered board. HVAC Service is the
group row, as the board shows it.

| Scenario | BU | Date | UI | Tool | Match |
|---|---|---|---|---|---|
| PIT 9/24 end of day | HVAC Service (group) | 2026-09-24 | 37j 99% | 37j 99% | Y |
| PIT 9/24 end of day | Plumbing Service | 2026-09-24 | 30j 102% | 30j 102% | Y |
| PIT 9/24 end of day | Drains | 2026-09-24 | 12j 105% | 12j 105% | Y |
| PIT 9/24 end of day | Electrical Service | 2026-09-24 | 10j 140% | 10j 140% | Y |
| PIT 9/24 end of day | HVAC Installation | 2026-09-24 | 6j 217% | 6j 217% | Y |
| Live (API) vs PIT 9/24 EOD | HVAC Service (group) | 2026-09-24 | 37j 99% | 37j 99% | Y |
| Live (API) vs PIT 9/24 EOD | Plumbing Service | 2026-09-24 | 30j 102% | 30j 102% | Y |
| Live (API) vs PIT 9/24 EOD | Drains | 2026-09-24 | 12j 105% | 12j 105% | Y |
| Live (API) vs PIT 9/24 EOD | Electrical Service | 2026-09-24 | 10j 140% | 10j 140% | Y |
| Live (API) vs PIT 9/24 EOD | HVAC Installation | 2026-09-24 | 6j 217% | 6j 217% | Y |
| PIT 9/23 08:00 | HVAC Service (group) | 2026-09-24 | 34j 80% | 34j 80% | Y |
| PIT 9/23 08:00 | Plumbing Service | 2026-09-24 | 12j 31% | 12j 31% | Y |
| PIT 9/23 08:00 | Drains | 2026-09-24 | 7j 59% | 7j 59% | Y |
| PIT 9/23 08:00 | Electrical Service | 2026-09-24 | 8j 90% | 8j 90% | Y |
| PIT 9/23 08:00 | HVAC Installation | 2026-09-24 | 6j 197% | 6j 197% | Y |
| PIT 9/14 end of day | HVAC Service (group) | 2026-09-14 | 31j 93% | 31j 93% | Y |
| PIT 9/14 end of day | HVAC Service (group) | 2026-09-15 | 31j 75% | 31j 75% | Y |
| PIT 9/14 end of day | HVAC Service (group) | 2026-09-16 | 26j 64% | 26j 64% | Y |
| PIT 9/14 end of day | HVAC Service (group) | 2026-09-17 | 27j 64% | 27j 64% | Y |
| PIT 9/14 end of day | HVAC Service (group) | 2026-09-18 | 24j 54% | 24j 54% | Y |
| PIT 9/14 end of day | HVAC Service (group) | 2026-09-19 | 0j No shifts | 0j No shifts | Y |
| PIT 9/14 end of day | HVAC Service (group) | 2026-09-20 | 0j No shifts | 0j No shifts | Y |
| PIT 9/14 end of day | HVAC Service (group) | 2026-09-21 | 22j 55% | 22j 55% | Y |
| PIT 9/14 end of day | HVAC Service (group) | 2026-09-22 | 25j 62% | 25j 62% | Y |
| PIT 9/14 end of day | HVAC Service (group) | 2026-09-23 | 12j 28% | 12j 28% | Y |
| PIT 9/14 end of day | Plumbing Service | 2026-09-14 | 28j 91% | 28j 91% | Y |
| PIT 9/14 end of day | Plumbing Service | 2026-09-15 | 26j 68% | 26j 68% | Y |
| PIT 9/14 end of day | Plumbing Service | 2026-09-16 | 24j 47% | 24j 47% | Y |
| PIT 9/14 end of day | Plumbing Service | 2026-09-17 | 7j 9% | 7j 9% | Y |
| PIT 9/14 end of day | Plumbing Service | 2026-09-18 | 5j 18% | 5j 18% | Y |
| PIT 9/14 end of day | Plumbing Service | 2026-09-19 | 0j No shifts | 0j No shifts | Y |
| PIT 9/14 end of day | Plumbing Service | 2026-09-20 | 0j No shifts | 0j No shifts | Y |
| PIT 9/14 end of day | Plumbing Service | 2026-09-21 | 5j 10% | 5j 10% | Y |
| PIT 9/14 end of day | Plumbing Service | 2026-09-22 | 4j 11% | 4j 11% | Y |
| PIT 9/14 end of day | Plumbing Service | 2026-09-23 | 1j 4% | 1j 4% | Y |
| PIT 9/14 end of day | Drains | 2026-09-14 | 9j 74% | 9j 74% | Y |
| PIT 9/14 end of day | Drains | 2026-09-15 | 5j 31% | 5j 31% | Y |
| PIT 9/14 end of day | Drains | 2026-09-16 | 1j 5% | 1j 5% | Y |
| PIT 9/14 end of day | Drains | 2026-09-17 | 0j 0% | 0j 0% | Y |
| PIT 9/14 end of day | Drains | 2026-09-18 | 1j 11% | 1j 11% | Y |
| PIT 9/14 end of day | Drains | 2026-09-19 | 0j No shifts | 0j No shifts | Y |
| PIT 9/14 end of day | Drains | 2026-09-20 | 0j No shifts | 0j No shifts | Y |
| PIT 9/14 end of day | Drains | 2026-09-21 | 1j 8% | 1j 8% | Y |
| PIT 9/14 end of day | Drains | 2026-09-22 | 0j 0% | 0j 0% | Y |
| PIT 9/14 end of day | Drains | 2026-09-23 | 1j 10% | 1j 10% | Y |
| PIT 9/14 end of day | Electrical Service | 2026-09-14 | 4j 134% | 4j 134% | Y |
| PIT 9/14 end of day | Electrical Service | 2026-09-15 | 8j 93% | 8j 93% | Y |
| PIT 9/14 end of day | Electrical Service | 2026-09-16 | 6j 49% | 6j 49% | Y |
| PIT 9/14 end of day | Electrical Service | 2026-09-17 | 8j 54% | 8j 54% | Y |
| PIT 9/14 end of day | Electrical Service | 2026-09-18 | 4j 39% | 4j 39% | Y |
| PIT 9/14 end of day | Electrical Service | 2026-09-19 | 0j No shifts | 0j No shifts | Y |
| PIT 9/14 end of day | Electrical Service | 2026-09-20 | 0j No shifts | 0j No shifts | Y |
| PIT 9/14 end of day | Electrical Service | 2026-09-21 | 4j 71% | 4j 71% | Y |
| PIT 9/14 end of day | Electrical Service | 2026-09-22 | 5j 37% | 5j 37% | Y |
| PIT 9/14 end of day | Electrical Service | 2026-09-23 | 0j 0% | 0j 0% | Y |
| PIT 9/14 end of day | HVAC Installation | 2026-09-14 | 6j 140% | 6j 140% | Y |
| PIT 9/14 end of day | HVAC Installation | 2026-09-15 | 7j 171% | 7j 171% | Y |
| PIT 9/14 end of day | HVAC Installation | 2026-09-16 | 3j 76% | 3j 76% | Y |
| PIT 9/14 end of day | HVAC Installation | 2026-09-17 | 5j 163% | 5j 163% | Y |
| PIT 9/14 end of day | HVAC Installation | 2026-09-18 | 3j 75% | 3j 75% | Y |
| PIT 9/14 end of day | HVAC Installation | 2026-09-19 | 2j No shifts | 2j No shifts | Y |
| PIT 9/14 end of day | HVAC Installation | 2026-09-20 | 0j No shifts | 0j No shifts | Y |
| PIT 9/14 end of day | HVAC Installation | 2026-09-21 | 2j 63% | 2j 63% | Y |
| PIT 9/14 end of day | HVAC Installation | 2026-09-22 | 1j 34% | 1j 34% | Y |
| PIT 9/14 end of day | HVAC Installation | 2026-09-23 | 3j 67% | 3j 67% | Y |
| Live 9/25 (UI read 15:00 MDT) | HVAC Service (group) | 2026-09-25 | 40j 104% | 40j 104% | Y |
| Live 9/25 (UI read 15:00 MDT) | Plumbing Service | 2026-09-25 | 29j 94% | 29j 94% | Y |
| Live 9/25 (UI read 15:00 MDT) | Drains | 2026-09-25 | 11j 78% | 11j 78% | Y |
| Live 9/25 (UI read 15:00 MDT) | Electrical Service | 2026-09-25 | 10j 139% | 10j 139% | Y |
| Live 9/25 (UI read 15:00 MDT) | HVAC Installation | 2026-09-25 | 6j 144% | 6j 144% | Y |

0 mismatch(es)

**Result: 70 of 70 cells match.** No mismatches needed explaining. Live values drift as
bookings land (the UI showed HVAC Service at 41 jobs · 106% earlier in the day during
planning, and 40 jobs · 104% at 15:00 when this table was recorded); point-in-time values do
not drift.
