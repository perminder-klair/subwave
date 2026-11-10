import { VOICE_KINDS, DEDUPE_KINDS } from './queue/kinds.js';

// Pure selection policy for the speech memory injected into DJ prompts. The
// booth log is station-wide; editorial continuity belongs to the current
// session, whose turns are stamped only after speech reaches air.

export interface PromptMemoryTurn {
  t: string;
  role: string;
  kind: string;
  text: string;
  meta?: { personaId?: string; personaName?: string; verbatim?: boolean; [k: string]: unknown };
}

// Words the station aired that no model wrote (#1908): a RAW POST /dj/say (the
// admin Say box, MCP's subwave_dj_announce and Connect agents all reach it) and
// a jingle's own script, which the on-demand play exists to air as an
// announcement. The turn still lands in the session, so the booth, GET /session
// and the booth carry show it, and djLog keeps its line; no prompt reads it.
// Negative context is still context: listed under "already said, do not
// repeat", an operator's emergency notice became the next banter's topic. The
// session's two prompt readers, promptMemoryEntries() below and
// session.windowMessages(), both ask withheldFromPrompts().
export const VERBATIM_META = { verbatim: true } as const;

export function withheldFromPrompts(turn: { meta?: { verbatim?: unknown } | null } | null | undefined): boolean {
  return turn?.meta?.verbatim === true;
}

export interface PromptMemoryEntry {
  t: string;
  kind: string;
  message: string;
}

// `personaId` is the session's OWN persona. A foreign speaker is either the
// mic-pass sign-off or a guest co-host, treated differently below.
export function promptMemoryEntries(
  turns: readonly PromptMemoryTurn[],
  personaId: string | null = null,
): PromptMemoryEntry[] {
  const out: PromptMemoryEntry[] = [];
  for (const turn of turns) {
    if (turn?.role !== 'segment') continue;
    if (withheldFromPrompts(turn)) continue;
    // recover() validates the array but not each turn, and getDjRecap() runs
    // synchronously inside request/DJ routes: a hand-edited state file must
    // not turn into a 500.
    const text = typeof turn.text === 'string' ? turn.text.trim() : '';
    if (!text) continue;
    const speakerId = turn.meta?.personaId;
    const foreign = Boolean(speakerId) && speakerId !== personaId;
    // The sign-off is the OUTGOING DJ's last line but lands in the session that
    // just started, so feeding it back is the cross-show bridge #1479 closes.
    // It stays in djLog and windowMessages(), which name its real speaker.
    if (foreign && turn.kind === 'handoff') continue;
    // Everything else foreign is a guest co-host. Carry the attribution so the
    // recap doesn't hand the host a guest's words as their own.
    const speaker = foreign ? (turn.meta?.personaName || 'another host') : null;
    out.push({ t: turn.t, kind: turn.kind, message: speaker ? `${speaker}: ${text}` : text });
  }
  return out.reverse();
}

// Shared recap policy. Callers supply the live DJ behaviour values; rendering
// can differ, but line count, lookback, kinds, dedupe and truncation cannot.
export function promptRecapEntries(
  entries: readonly PromptMemoryEntry[],
  { limit, withinMinutes, maxChars }: { limit: number; withinMinutes: number; maxChars: number },
  now = Date.now(),
): PromptMemoryEntry[] {
  if (limit <= 0 || withinMinutes < 0 || maxChars < 1) return [];
  const cutoff = now - withinMinutes * 60_000;
  const kinds = new Set<string>();
  const picked: PromptMemoryEntry[] = [];
  for (const entry of entries) {
    if (!VOICE_KINDS.has(entry.kind)) continue;
    const at = Date.parse(entry.t);
    if (!Number.isFinite(at) || at > now) continue;
    if (at < cutoff) break;
    if (DEDUPE_KINDS.has(entry.kind)) {
      if (kinds.has(entry.kind)) continue;
      kinds.add(entry.kind);
    }
    const message = typeof entry.message === 'string' ? entry.message.replace(/\s+/g, ' ').trim() : '';
    if (!message) continue;
    picked.push({ ...entry, message: message.length > maxChars ? message.slice(0, maxChars - 1) + '…' : message });
    if (picked.length >= limit) break;
  }
  return picked;
}
