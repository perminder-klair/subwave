// The event-turn clause that tells the agent to write (or skip) a spoken
// link. Extracted from dj-agent.ts's runTrackEvent so the two link postures —
// the ordinary "introduce the pick, vary your opener" contract and the
// linkStyle:'announce' matter-of-fact contract — are each one pure, testable
// function of their inputs.
//
// The full link contract (introduce the pick, no back-announce) lives in the
// "say" schema description (dj-agent/schemas.ts's pickSchemaBase), which
// travels on every call — this clause only TRIGGERS the link and carries the
// per-pick extras the schema can't know (the intro_ms budget, the opener
// blocklist, or — for announce — nothing extra at all).

export interface BuildLinkClauseInput {
  /** wantLink must already be true for this to be called; kept out of the
   *  signature — the caller decides the silent branch. */
  djMode: boolean;
  announce: boolean;
  /** A rotating forward-looking angle (dj.pickAngle('link')), or null when
   *  none was drawn / announce mode never draws one. */
  angle: string | null;
  /** The station's recent link openers, oldest-first-trimmed by the caller. */
  recentOpeners: string[];
}

/**
 * The clause appended after "Also write the 'say' link — it airs as your pick
 * starts." Natural output is byte-identical to the pre-extraction template.
 */
export function buildLinkClause({ djMode, announce, angle, recentOpeners }: BuildLinkClauseInput): string {
  if (announce) {
    // No intro_ms sentence — an announcement is always short enough to land
    // clear of any vocal entry. No angle, no opener blocklist: alternating
    // between exactly two fixed forms IS the variety. This is a sane fallback
    // description only — the model's `say` here only signals "speak this
    // pick"; the runTrackEvent chokepoint in dj-agent.ts overwrites the text
    // with announce-line.ts's own composed, alternating line before it airs.
    return ' Also write the "say" link — it airs as your pick starts.'
      + ' The "say" line must be exactly one of: "This is <artist>." or "Next up, <artist>." — nothing before or after it: no title, album, year, feel, or clock.'
      + ' Use the artist name exactly as shown on the chosen track.';
  }
  const varietyClause = ` Approach for this link: ${angle} Vary your first words — don't default to "here's", "this is", or "coming up".`
    + (recentOpeners.length
        ? ` You opened recent lines with ${recentOpeners.slice(0, 6).map(o => `"${o}…"`).join(', ')} — start this one differently.`
        : '');
  return djMode
    ? ` Also write the "say" link — it airs as your pick starts. If the track you pick shows an intro_ms, keep the link short enough to finish before then, so you land just as the vocals come in.${varietyClause}`
    : ` Also write the "say" link — it airs as your pick starts.${varietyClause}`;
}
