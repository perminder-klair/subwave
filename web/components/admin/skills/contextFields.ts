// Shared "right now" context-field vocabulary for the Skills admin (#471).
// The skill edit/create sheet (SkillEditModal) renders these as a chip bank, so
// the labels + fallback list + the comma-string parser live here, defined once.

// Friendly labels for the context fields. Keys are the controller's
// CONTEXT_FIELDS vocabulary; anything not listed falls back to the raw key.
export const CONTEXT_FIELD_LABELS: Record<string, string> = {
  date: 'Date & season',
  clock: 'Clock time',
  time: 'Daypart',
  weather: 'Weather',
  festival: 'Festival',
  show: 'Current show',
  listeners: 'Listener count',
};

// Fallback vocabulary if the controller doesn't send knownContextFields.
export const CONTEXT_FIELDS_FALLBACK = ['date', 'clock', 'time', 'weather', 'festival', 'show', 'listeners'];

// Split a comma-separated `context` value into trimmed, non-empty tokens.
export function splitContext(s?: string): string[] {
  return typeof s === 'string' ? s.split(',').map(t => t.trim()).filter(Boolean) : [];
}
