// Canonical GitHub URLs, one place for every share-to-community flow.

// The community catalog repo, split out of the code repo so contributions
// review and publish on their own cadence (stations fetch the catalog live).
// COMMUNITY_CATALOG_URL overrides the FETCH url; this is only the human link.
export const COMMUNITY_REPO_URL = 'https://github.com/getsubwave/community';

// Opens a GitHub Issue Form; a workflow in the community repo turns the issue
// into a one-file PR and the catalog rebuilds on merge. `params` keys must match
// the form field ids for GitHub to prefill them.
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
export function appSubmitUrl(params: Record<string, string | undefined> = {}): string {
  return communitySubmitUrl('add-app.yml', params);
}
export function reportAppUrl(params: Record<string, string | undefined> = {}): string {
  return communitySubmitUrl('report-app.yml', params);
}
export function pluginSubmitUrl(params: Record<string, string | undefined> = {}): string {
  return communitySubmitUrl('add-plugin.yml', params);
}
export function reportPluginUrl(params: Record<string, string | undefined> = {}): string {
  return communitySubmitUrl('report-plugin.yml', params);
}
