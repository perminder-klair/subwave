// Pure planning failures shared by generation, coverage acceptance and tests.
export const MUSICAL_LEANINGS_GUIDE = 'https://github.com/perminder-klair/subwave/discussions/1817';
export class ShowPlanningError extends Error {
  constructor(readonly code: 'persona-readiness' | 'library-fit' | 'library-coverage' | 'library-unavailable', message: string) {
    super(message);
    this.name = 'ShowPlanningError';
  }
}
export function musicalDetailError(names: string[]): ShowPlanningError {
  return new ShowPlanningError('persona-readiness', `More musical detail needed: ${names.join(' and ')} ${names.length === 1 ? 'needs' : 'need'} a little more musical detail before generating this Sub/Show. Add a sentence about the genres, artists or musical qualities they enjoy to their Soul or optional Musical Leanings, then try again.\n\nHow to give your DJ Musical Leanings: ${MUSICAL_LEANINGS_GUIDE}`);
}
export function libraryFitError(reason: string): ShowPlanningError {
  return new ShowPlanningError('library-fit', `No suitable musical direction for this Sub/Show: ${reason} Try another Sub/Show type, adjust the DJ's musical preferences, or add music in a suitable neighbouring territory.`);
}
export function coverageError(minutes: number, required: number, count: number): ShowPlanningError {
  return new ShowPlanningError('library-coverage', `Not enough matching music: this ${minutes}-minute show needs at least ${required} eligible tracks, but the proposed settings match only ${count} after filters and exclusions. Try a shorter slot, choose another Sub/Show type, or add more suitable music.`);
}
// A spacing window of N needs N+1 artists for rotation. Very short slots
// cannot require more artists than their twice-airtime track pool. Zero still
// keeps the picker's always-on back-to-back artist guard.
export function requiredShowArtists(tracks: number, spacing: number): number {
  return Math.min(Math.max(1, tracks), Math.max(1, spacing) + 1);
}
export function artistCoverageError(required: number, count: number, spacing: number): ShowPlanningError {
  return new ShowPlanningError('library-coverage', `Not enough artist variety: Artist Spacing is ${spacing} slots, so this Sub/Show needs at least ${required} distinct artists, but its filters and exclusions leave only ${count}. Choose a better-covered musical direction, a shorter slot, or add suitable music. Artist Spacing is configured in Music Selection > Advanced.`);
}
export function coverageUnavailable(warnings: string[]): boolean {
  return warnings.some(warning => /not (?:present|counted|an active lock)|could not|failed to resolve|filter is not active/i.test(warning));
}
export interface MusicEvidenceProfile { id: string; name: string; soul: string; musicLean: string }
export interface MusicEvidence { personaId: string; source: 'soul' | 'musicLean'; quote: string }
// Validate provenance locally. The model judges musical meaning; an invented
// quotation or another persona's text can never count as supporting evidence.
export function missingMusicalEvidence(profiles: MusicEvidenceProfile[], evidence: MusicEvidence[], genreNames: string[] = []): string[] {
  const normal = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
  const genrePatterns = genreNames.filter(genre => normal(genre).length >= 2).map(genre =>
    new RegExp(`(?:^|[^a-z0-9])${normal(genre).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`));
  const namesGenre = (text: string) => genrePatterns.some(pattern => pattern.test(normal(text)));
  // Clear genre preferences remain evidence even if the model quotes the
  // wrong field. Musical Leanings is explicitly about music; in Soul require
  // an expressed preference as well as a catalogue genre.
  const directPreference = (profile: MusicEvidenceProfile) => namesGenre(profile.musicLean)
    || (/\b(loves?|enjoys?|prefers?|likes?|listens?|tastes?|favourites?|favorites?)\b/i.test(profile.soul) && namesGenre(profile.soul));
  // A model can copy a real quote yet mistake delivery for musical taste.
  // Reject that obvious case locally, while allowing a quote that also names
  // music, a library genre or a concrete musical feature. This is a narrow
  // negative guard, not an attempt to classify every possible musical taste.
  const presentationOnly = (quote: string) => {
    const text = normal(quote);
    return /\b(presenter|dj|host|voice|humou?r|links?|delivery|plainspoken|wistful|welcoming|understated|relaxed|enthusiastic|conversational|everyday|speaking)\b/.test(text)
      && !/\b(music(?:al)?|songs?|songwriting|melod(?:y|ies|ic)|rhythms?|harmon(?:y|ies|ic)|instruments?|instrumentation|guitars?|piano|bass|drums?|synths?|arrangements?|listening)\b/.test(text)
      && !namesGenre(text);
  };
  return profiles.filter(profile => !directPreference(profile) && !evidence.some(item => item.personaId === profile.id
    && normal(item.quote).length >= 3 && normal(profile[item.source]).includes(normal(item.quote)) && !presentationOnly(item.quote)))
    .map(profile => profile.name);
}
