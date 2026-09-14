// The event-turn clause telling the agent to write a spoken link. The full
// link contract lives in the "say" schema description (schemas.ts); this
// clause only triggers the link and carries the per-pick extras.

export interface BuildLinkClauseInput {
  // Caller only calls this when wantLink is true.
  djMode: boolean;
  announce: boolean;
  angle: string | null;
  recentOpeners: string[];
}

export function buildLinkClause({ djMode, announce, angle, recentOpeners }: BuildLinkClauseInput): string {
  if (announce) {
    // Fallback description only: runTrackEvent overwrites the text with
    // announce-line.ts's composed alternating line before it airs.
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
