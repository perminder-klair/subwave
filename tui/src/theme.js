// Classic Winamp 2.x palette + glyph tokens for the terminal listener.
// Every component imports from here so the look stays consistent — if you
// want to retune the skin, this is the file.
//
// Colour names are Ink's named colours (no truecolour) so the skin survives
// any 16-colour terminal that classic Winamp would have shipped on anyway.
export const c = {
  chrome:  'gray',          // window border + inactive chrome
  title:   'yellowBright',  // active titlebar text — Winamp's amber gradient
  lcdDim:  'green',         // LCD bg / dim digits
  lcd:     'greenBright',   // active LCD digits / marquee
  bitrate: 'cyan',          // kbps / kHz / stereo LEDs
  accent:  'magenta',       // Winamp-purple — requests, voice marker
  warn:    'yellow',
  danger:  'red',
  ok:      'green',
};

export const glyph = {
  prev:   '⏮',
  play:   '▶',
  pause:  '⏸',
  stop:   '■',
  next:   '⏭',
  led:    '●',
  ledOff: '○',
  shimL:  '░▒▓',
  shimR:  '▓▒░',
  carat:  '>',
  voice:  '◆',
  djDot:  '·',
  track:  '▶',
  request:'✦',
};

// Honest stream-format badge — these are the values `liquidsoap/radio.liq`
// encodes with (`output.icecast(%mp3(bitrate=192))`, default sample rate
// 44.1 kHz, stereo). Change these if the encoder ever changes.
export const STREAM_BITRATE_LABEL = '192kbps';
export const STREAM_SAMPLERATE_LABEL = '44kHz';
export const STREAM_CHANNELS_LABEL = 'STEREO';
