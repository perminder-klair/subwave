// The canonical GitHub repo URL, shared by anything that links back to it
// (community submissions, station submissions, footer links). Kept here so the
// "share to community" flows in the admin UI have one place to point at.
export const REPO_URL = 'https://github.com/perminder-klair/subwave';

// Prefilled community-skill submission — opens the add-skill Issue Form (no fork,
// no YAML). A workflow (.github/workflows/skill-submission.yml) turns the issue
// into a one-file PR under controller/src/skills/community/<slug>/. `params` map
// to the form field ids, so GitHub prefills the fields.
export function skillSubmitUrl(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams({ template: 'add-skill.yml' });
  for (const [k, v] of Object.entries(params)) {
    if (v && v.trim()) qs.set(k, v.trim());
  }
  return `${REPO_URL}/issues/new?${qs.toString()}`;
}

// Prefilled community-persona submission — opens the add-persona Issue Form (no
// fork, no YAML). A workflow (.github/workflows/persona-submission.yml) turns
// the issue into a one-file PR under controller/src/personas/community/<slug>/.
// `params` map to the form field ids, so GitHub prefills the fields.
export function personaSubmitUrl(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams({ template: 'add-persona.yml' });
  for (const [k, v] of Object.entries(params)) {
    if (v && v.trim()) qs.set(k, v.trim());
  }
  return `${REPO_URL}/issues/new?${qs.toString()}`;
}
