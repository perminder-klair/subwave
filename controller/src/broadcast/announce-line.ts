// Composes the fixed announce-mode link line in CODE rather than asking the
// model to produce it: a model cannot reliably hold to an exact fixed
// string, and it cannot alternate with a line it is never shown — the agent
// path writes the link before the pick after it airs, and the scripted path
// never carries the previous link forward at all. Per the station's own
// posture (fix shape in code, don't just instruct the model harder), both
// call sites compose the line here and only ask the model whether to speak.
//
// One shared alternation for the whole air chain: the agent picker and the
// stateless pool picker are two different code paths for the same on-air
// slot, and a listener hears one continuous sequence of links regardless of
// which path produced each one.
let lastForm: 'this-is' | 'next-up' | null = null;

/**
 * `This is <artist>.` or `Next up, <artist>.`, alternating every call.
 * Empty/whitespace-only artist returns '' — the caller's signal for "no link".
 */
export function announceLine(artist: string): string {
  const trimmed = String(artist ?? '').trim();
  if (!trimmed) return '';
  const form = lastForm === 'this-is' ? 'next-up' : 'this-is';
  lastForm = form;
  return form === 'this-is' ? `This is ${trimmed}.` : `Next up, ${trimmed}.`;
}

/** Test-only: reset the alternation so a test can assert on a known next form. */
export function resetAnnounceAlternation(): void {
  lastForm = null;
}
