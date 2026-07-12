// The canonical GitHub URLs, kept here so every "share to community" flow and
// back-link has one place to point at.

// The main SUB/WAVE project repo — code, issues, docs.
export const REPO_URL = 'https://github.com/perminder-klair/subwave';

// The community catalog repo — where shared skills / personas / shows / stations
// live, and where the "share to community" issue forms open. Split out of the
// code repo so contributions review + publish on their own cadence (the running
// station fetches the catalog live). Override the fetch URL per station with
// COMMUNITY_CATALOG_URL; this constant is only the human-facing GitHub link.
export const COMMUNITY_REPO_URL = 'https://github.com/getsubwave/subwave-community';

// Build a prefilled community submission link — opens a GitHub Issue Form (no
// fork, no YAML). A workflow in the community repo turns the issue into a
// one-file PR; the catalog rebuilds on merge and the entry becomes installable
// from every station shortly after. `params` map to the form field ids, so
// GitHub prefills the fields.
function communitySubmitUrl(template: string, params: Record<string, string | undefined> = {}): string {
  const qs = new URLSearchParams({ template });
  for (const [k, v] of Object.entries(params)) {
    if (v && v.trim()) qs.set(k, v.trim());
  }
  return `${COMMUNITY_REPO_URL}/issues/new?${qs.toString()}`;
}

export function skillSubmitUrl(params: Record<string, string | undefined> = {}): string {
  return communitySubmitUrl('add-skill.yml', params);
}
export function personaSubmitUrl(params: Record<string, string | undefined> = {}): string {
  return communitySubmitUrl('add-persona.yml', params);
}
export function showSubmitUrl(params: Record<string, string | undefined> = {}): string {
  return communitySubmitUrl('add-show.yml', params);
}
export function stationSubmitUrl(params: Record<string, string | undefined> = {}): string {
  return communitySubmitUrl('add-station.yml', params);
}
export function reportStationUrl(params: Record<string, string | undefined> = {}): string {
  return communitySubmitUrl('report-station.yml', params);
}
