// Deterministic text rule checks for llm-bench — the objective counterpart of
// the hard rules in djSystem and the schema descriptions. Every check returns
// a named rule id so the report can show a model's characteristic failures,
// not just a pass rate. Pure module — pinned by scripts/llm-bench-rules.test.ts.

export const BANNED_PHRASES = ['and now', 'next up', 'coming up next'];

export interface SpokenRuleOpts {
  /** hourly time-check: the spoken time must be words, never digits */
  noDigits?: boolean;
  /** flag a spoken HH:MM clock (links written before air time must not state it) */
  noClock?: boolean;
  /** recent opening lines the output must not re-open with */
  recentOpeners?: string[] | null;
  /** sentence ceiling; default 5 (the "2-4 sentences" hard rule plus slack for
   *  a trailing fragment — flagging at exactly 4 produced false positives on
   *  legitimate short closers) */
  maxSentences?: number;
}

export function checkSpokenLine(text: unknown, opts: SpokenRuleOpts = {}): string[] {
  const v: string[] = [];
  const t = String(text ?? '').trim();
  if (!t) return ['empty'];

  const lower = t.toLowerCase();
  for (const p of BANNED_PHRASES) {
    if (lower.includes(p)) v.push(`banned-phrase:${p.replace(/\s+/g, '-')}`);
  }

  // Stage directions / markup the TTS would read out loud.
  if (/\*[^*]+\*/.test(t)) v.push('stage-direction:asterisks');
  if (/\[[^\]]+\]/.test(t)) v.push('stage-direction:brackets');
  if (/^["'“”].*["'“”]$/.test(t)) v.push('wrapping-quotes');
  if (/\p{Extended_Pictographic}/u.test(t)) v.push('emoji');

  if (opts.noDigits && /\d/.test(t)) v.push('digits-in-spoken-time');
  if (opts.noClock && /\b\d{1,2}:\d{2}\b/.test(t)) v.push('clock-leak');

  const max = opts.maxSentences ?? 5;
  if (countSentences(t) > max) v.push(`over-length:${max}-sentences`);

  if (opts.recentOpeners?.length) {
    const opener = firstWords(t, 4);
    for (const o of opts.recentOpeners) {
      if (opener && opener === firstWords(o, 4)) {
        v.push('opener-repeat');
        break;
      }
    }
  }
  return v;
}

// Sentence count by terminal-punctuation groups; ellipses collapse to one.
export function countSentences(t: string): number {
  const m = String(t).replace(/[.]{2,}|…/g, '.').match(/[^.!?]+[.!?]+/g);
  // Text with no terminal punctuation at all is one sentence, not zero.
  return m ? m.length : 1;
}

export function firstWords(t: string, n: number): string {
  return String(t || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, n)
    .join(' ');
}

/** ack fields carry a "max 20 words" schema description — checked with slack
 *  (25) so we flag real rambles, not a model counting hyphenated words differently. */
export function checkAck(text: unknown): string[] {
  const v = checkSpokenLine(text);
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
  if (words > 25) v.push('ack-over-20-words');
  return v;
}
