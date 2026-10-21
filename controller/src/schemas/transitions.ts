// Why a DJ transition effect did not make it onto a seam — the vocabulary of the
// durable seam record (`plays.transition_drops`, the `track.play` event and the
// Stats panel's Transitions card). One code per strip site in the drain, so a
// count means one thing; the booth log keeps its own human sentence per site.
//
// Codes are STORED, so they are append-only: renaming one orphans every row
// already written under it. Retire a code by leaving it here unused.
export const MIX_DROP_REASONS = [
  'dj-mode-off',     // the on-air persona left DJ mode between pick and drain
  'switched-off',    // the operator switched this effect off (transitions.effects)
  'no-predecessor',  // nothing on air to transition from (first track after boot)
  'stem-seam',       // a pre-rendered stem blend owns the seam
  'show-boundary',   // the seam is a show-change cut, which airs as a plain fade
  'variety',         // the anti-streak rule: a third identical ask in a row
  'yields-to-exit',  // the previous track already exits through a washout or loop
  'pair-fit',        // the measured pair does not suit this effect
  'no-tempo',        // the exit loop needs the track's measured tempo
  'bed',             // an instrumental bed replaced the seam it was chosen for
  'pause-talk',      // a pause-and-talk break replaced the seam it was chosen for
  'jingle-seam',     // a jingle aired between the two tracks; the mixer stood down
] as const;

export type MixDropReason = (typeof MIX_DROP_REASONS)[number];

export const MIX_DROP_REASON_LABELS: Record<MixDropReason, string> = {
  'dj-mode-off': 'DJ mode off',
  'switched-off': 'Switched off',
  'no-predecessor': 'Nothing to follow',
  'stem-seam': 'Stem blend seam',
  'show-boundary': 'Show change cut',
  'variety': 'Repeat rule',
  'yields-to-exit': 'Previous exit effect',
  'pair-fit': 'Pair did not suit it',
  'no-tempo': 'No measured tempo',
  'bed': 'Bed took the seam',
  'pause-talk': 'Pause-and-talk break',
  'jingle-seam': 'Jingle in between',
};
