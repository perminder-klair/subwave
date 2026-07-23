// Shared slug rule for on-disk audio-library names (sfx, beds): the slug is
// both the JSON-sidecar key and the audio filename stem, so the two libraries
// must never drift on what characters survive.
export function slugify(name: string): string {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
