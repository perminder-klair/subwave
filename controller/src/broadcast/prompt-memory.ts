// Pure selection policy for the speech memory injected into DJ prompts.
//
// The operator booth log is station-wide, but editorial continuity belongs to
// the current DJ session. Session turns are already stamped only after speech
// reaches air, persisted across controller restarts, hard-reset on a genuine
// show boundary, and retained across autonomous soft shifts. Keep that boundary
// decision here rather than teaching every prompt caller about session turns.

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

// `personaId` is the session's OWN persona. A segment stamped with a different
// speaker is either the mic-pass sign-off or a guest co-host's line, and the
// two are treated differently — see below.
export function promptMemoryEntries(
  turns: readonly PromptMemoryTurn[],
  personaId: string | null = null,
): PromptMemoryEntry[] {
  const out: PromptMemoryEntry[] = [];
  for (const turn of turns) {
    if (turn?.role !== 'segment') continue;
    // Turns arrive from session.json via recover(), which validates the array
    // but not each turn — windowMessages() guards the same field for the same
    // reason. getDjRecap() is called synchronously inside request/DJ routes, so
    // a hand-edited state file must not turn into a 500.
    const text = typeof turn.text === 'string' ? turn.text.trim() : '';
    if (!text) continue;
    const speakerId = turn.meta?.personaId;
    const foreign = Boolean(speakerId) && speakerId !== personaId;
    // The handoff sign-off is spoken by the OUTGOING DJ but lands in the session
    // that just started (dj-agent.runPersonaHandoff airs it after maybeRoll).
    // It is the previous show's last line, so feeding it back is exactly the
    // cross-show semantic bridge #1479 closes — just one segment later. It stays
    // in djLog and in windowMessages(), which names its real speaker.
    if (foreign && turn.kind === 'handoff') continue;
    // Everything else foreign is a guest co-host (announceExchange rotates the
    // speaker). Carry the attribution the booth log's `logText` used to supply,
    // so the recap doesn't hand the host a guest's words as their own.
    const speaker = foreign ? (turn.meta?.personaName || 'another host') : null;
    out.push({ t: turn.t, kind: turn.kind, message: speaker ? `${speaker}: ${text}` : text });
  }
  return out.reverse();
}
