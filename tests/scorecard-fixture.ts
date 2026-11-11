/** Invented outbound scorecards in the shape Netic sends (docs/netic-api.md, 2026-11-11). No real calls. */

export function analysisJson(opts: { score: number; flagged: boolean; booked?: boolean; recorded?: number; decision?: number }): string {
  return JSON.stringify({
    aggregate_score: opts.score,
    is_lead: true,
    is_booked: opts.booked ?? false,
    is_flagged: opts.flagged,
    is_excused: false,
    sections: [
      {
        name: "Options Were Reviewed",
        parameters: [
          { name: "Make Clear the Decision Is the Customer's", score: opts.decision ?? 0.6, reason: "Invented reason one.", not_applicable: false },
          { name: "Confirm Options and Pricing Were Reviewed", score: null, reason: "Invented reason two.", not_applicable: true },
        ],
      },
      {
        name: "Recorded Line / All Parties Aware",
        parameters: [{ name: "State the Line Is Recorded", score: opts.recorded ?? 1, reason: "Invented reason three.", not_applicable: false }],
      },
    ],
  });
}

export const ANALYSIS = analysisJson({ score: 0.6, flagged: true });
