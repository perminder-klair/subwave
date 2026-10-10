// Banter window openings and gaps feed talk-scheduler; frequency eligibility stays in dj-gate.
// #1419, #1500, #310.
export const BANTER_SLOTS = [20, 50] as const;

// Twice the quiet gap: a break landing just before the slot opens clears by the
// halfway point, leaving room to render and still finish clear of :30/:00.
export const BANTER_WINDOW_MINUTES = 10;

// Minimum quiet gap. Every STANDALONE talk break counts (what
// queue.getLastTalkBreakAt() reports); track-tied links are excluded there, or
// a chatty DJ-mode station would never banter.
export const BANTER_MIN_GAP_MS = 5 * 60_000;

