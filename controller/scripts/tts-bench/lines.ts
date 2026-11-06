// The lines tts-bench renders: what a SUB/WAVE DJ actually says, grouped by
// what tends to break a voice. `text` is the written line, as the model would
// write it, and it goes through the live normalizeForSpeech() on its way to the
// engine. score.py measures the transcript against `spoken` when a line has
// one, else `text`.
//
// Ids are stable: reports are compared across runs by id, so change a line's
// text under a new id rather than editing it in place.

export type BenchLine = {
  id: string;
  category: 'ident' | 'link' | 'long' | 'names' | 'numbers' | 'punctuation' | 'non-english';
  text: string;
  // What a listener should hear, for a line whose written form is not it
  // ("7:45", "£25"). Scoring against the written form would charge every
  // engine for the transcriber writing "seven forty-five".
  spoken?: string;
  // The persona's on-air language. Absent = English.
  language?: string;
};

export const LINES: BenchLine[] = [
  { id: 'ident-short', category: 'ident', text: "You're listening to SUB/WAVE." },
  { id: 'ident-night', category: 'ident', text: 'SUB/WAVE, still on, still yours. Stay with us.' },

  {
    id: 'link-back-forward',
    category: 'link',
    text: "That was Khruangbin, slow and warm, the right weight for a grey afternoon. Here's something with a bit more pulse to it.",
  },
  {
    id: 'link-request',
    category: 'link',
    text: "This one's a request from Priya, who says it got her through a long drive home. Priya, this is for you.",
  },

  {
    id: 'long-break',
    category: 'long',
    text: 'Right, a quick look outside before the next run. Cloud has been sitting on the city since lunchtime, '
      + "and it isn't going anywhere tonight. Expect light rain after eight, clearing towards midnight, with a "
      + "low of nine degrees. If you're heading out, take a coat; if you're staying in, you're in the right "
      + "place. We've got another hour of the slow stuff, then the tempo comes up for the late shift. Stay with me.",
  },

  { id: 'names-nordic', category: 'names', text: 'That was Sigur Rós with Hoppípolla, and before that, MØ with Lean On.' },
  { id: 'names-mixed', category: 'names', text: "Björk, then Beyoncé, then Daft Punk's Harder, Better, Faster, Stronger." },
  { id: 'names-ireland', category: 'names', text: 'Requested by Siobhán in Llanelli: Ólafur Arnalds, and then Saoirse Casey.' },

  {
    id: 'numbers-clock',
    category: 'numbers',
    text: "It's 7:45 on a Tuesday, 18°C, with the wind at 12 miles an hour.",
    spoken: "It's seven forty-five on a Tuesday, eighteen degrees Celsius, with the wind at twelve miles an hour.",
  },
  {
    id: 'numbers-chart',
    category: 'numbers',
    text: 'Released in 1987, it reached No. 1 in the UK and sold 2.5 million copies.',
    spoken: 'Released in nineteen eighty-seven, it reached number one in the UK and sold two point five million copies.',
  },
  {
    id: 'numbers-money',
    category: 'numbers',
    text: 'Tickets are £25, doors at 8pm, on the 3rd of November.',
    spoken: 'Tickets are twenty-five pounds, doors at eight p.m., on the third of November.',
  },

  { id: 'punct-pause', category: 'punctuation', text: 'Hold on, wait for it... there. That is the one.' },
  // Not "bass line": the transcriber hears "baseline" from every engine.
  { id: 'punct-question', category: 'punctuation', text: 'Did you catch that drum break? Unreal! Again, from the top.' },

  {
    id: 'spanish-time',
    category: 'non-english',
    language: 'Spanish',
    text: 'Son las ocho y cuarto. Esto es SUB/WAVE, y ahora suena Rosalía.',
  },
];
