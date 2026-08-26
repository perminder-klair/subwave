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
}

export interface PromptMemoryEntry {
  t: string;
  kind: string;
  message: string;
}

export function promptMemoryEntries(turns: readonly PromptMemoryTurn[]): PromptMemoryEntry[] {
  return turns
    .filter((turn) => turn.role === 'segment' && turn.text.trim())
    .map((turn) => ({ t: turn.t, kind: turn.kind, message: turn.text }))
    .reverse();
}
