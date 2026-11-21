/** Structured Genius connections and credits stay out of automatic recycling. */
const PROTECTED_CONNECTION_TYPES = new Set(['samples', 'sampled_in', 'cover_of', 'covered_by']);

export function exemptFromAutomaticRecycleBin(provider: string, category: string, evidence: string): boolean {
  if (provider === 'genius' && category === 'credits') return true;
  if (provider !== 'genius' || category !== 'musical-connections') return false;
  try {
    const type = (JSON.parse(evidence) as { type?: unknown }).type;
    return typeof type === 'string' && PROTECTED_CONNECTION_TYPES.has(type);
  } catch {
    return false;
  }
}
