# Requests for Netic

Draft asks for the Netic team. Justin sends them; nothing here has gone to Netic yet.

## 1. Inbound AI call transcripts in the Reports Export API

The spec says `/api/public/metrics/interactions` returns "the same rows as the dashboard
Drill Down CSV export." The Calls Drill Down CSV has an `AI Call Transcript` column, but the
API does not return it: no transcript key on `modality=call` rows, and no parameter or path
that adds one (probed 2026-09-30; details in `docs/netic-api.md`).

Ask:

- Add the transcript to `modality=call` rows, e.g. `aiCallTranscript` (string, null when
  none). If payload size is a concern, put it behind `includeTranscript=true`, the way
  `calls/outbound` already carries `transcript`.
- Keep the same `Agent:` / `User:` turn format as the CSV.
- If there is an AI summary or classification per call (the Hub shows a Customer Summary),
  expose that too.

Why: we want to search and classify inbound calls by what was said (objections, reasons for
escalation, missed bookings). Today that needs a manual CSV export per tenant and a join on
phone number plus minute, because the CSV has no interaction id.

## 2. Interaction id in the Drill Down CSVs

Add the interaction `id` (the API's UUID) to the Calls and Texts Drill Down exports so rows
join to the API exactly. Phone plus minute and ServiceTitan call id both repeat.

## 3. Inbound text conversations

The Texts Drill Down CSV and `modality=inbound_text` / `recapture_text` rows carry no message
content. Same ask as 1 for text threads.

## 4. Scheduler bookings timeouts

`/api/public/metrics/bookings/scheduler` takes 9 to 16 s per cold request regardless of range
and returns 500 `Failed to fetch scheduler booked jobs` once a request passes about 15 s. It hit
every tenant during the 2026-09-25 probe (nash failed 7 times in a row); warm calls answer in
under 2.5 s. We retry, but a longer server timeout or a faster query would fix it.
