// Pure selection policy for the speech memory injected into DJ prompts. The
// booth log is station-wide; editorial continuity belongs to the current
// session, whose turns are stamped only after speech reaches air.

export interface PromptMemoryTurn {
  t: string;
  role: string;
  kind: string;
  text: string;
  meta?: { personaId?: string; personaName?: string; [k: string]: unknown };
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
