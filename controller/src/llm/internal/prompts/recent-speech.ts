// Recent speech is negative memory only. Bracketed delivery directions in an
// old line are especially easy for a model to copy, so they must not cross the
// prompt boundary. Recap metadata (for example, `[link]`) is kept by only
// applying this to the spoken part of a formatted recap line.
const SPOKEN_TAG = /\[[^\]\r\n]{1,80}\]\s*/g;

export function stripSpokenTags(value: unknown): string {
  return String(value ?? '').replace(SPOKEN_TAG, '');
}

export function stripRecapSpokenTags(value: unknown): string {
  return String(value ?? '').split('\n').map((line) => {
    const spokenStart = line.indexOf(': "');
    if (spokenStart < 0) return stripSpokenTags(line);
    return line.slice(0, spokenStart + 3) + stripSpokenTags(line.slice(spokenStart + 3));
  }).join('\n');
}
