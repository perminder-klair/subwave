// Banter scheduling numbers (#1419). The window/gap state machine they feed is
// talk-scheduler.ts's, generalised to every talk kind (#1500); the frequency
// ladder is dj-gate.ts's. This file is only the constants.

// Minute each banter window OPENS. No other wall-clock talker owns these — the
// ident cron is :15/:30/:45 and the hourly check is :00 (#310).
export const BANTER_SLOTS = [20, 50] as const;

// Twice the quiet gap: a break landing just before the slot opens clears by the
// halfway point, leaving room to render and still finish clear of :30/:00.
export const BANTER_WINDOW_MINUTES = 10;

// Minimum quiet gap. Every STANDALONE talk break counts (what
// queue.getLastTalkBreakAt() reports); track-tied links are excluded there, or
// a chatty DJ-mode station would never banter.
export const BANTER_MIN_GAP_MS = 5 * 60_000;

