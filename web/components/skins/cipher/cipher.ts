// The rotor machine behind the Cipher skin, as pure data and functions. Three
// rotors wired like the historical Enigma I, II and III with reflector B, and
// II and III step as the real machine's middle and right rotors do, as letters
// pass through, whether the listener types them or the lampboard spells the
// song. Rotor I's position is the VOLUME, so it never steps, and so II never
// double-steps either: a real machine set the same way (rings at A, no
// plugboard) reads the listener's request back only until rotor II comes round
// to E, where the real one would double-step II and turn I over. No React
// here, so the wiring can be tested on its own.

import { foldBpm } from '../shared';

/** The Enigma's QWERTZ rows, shared by the lampboard and the keyboard. */
export const ROWS = ['QWERTZUIO', 'ASDFGHJK', 'PYXCVBNML'] as const;
/** The lampboard in reading order, for the tuning sweep. */
export const SCAN = ROWS.join('');
/** Longest request the tape holds. The schema allows more; the tape doesn't. */
export const MSG_MAX = 64;
/** Rotor I has 26 positions, 0 (silent) to 25 (full volume). */
export const VOL_STOPS = 25;

export const mod26 = (x: number): number => ((x % 26) + 26) % 26;
/** Position (any integer) → its letter. */
export const chr = (x: number): string => String.fromCharCode(65 + mod26(x));
/** Rotor I's readout: two digits, blank past either end stop. */
export const volGlyph = (x: number): string =>
  x < 0 || x > VOL_STOPS ? '' : String(x).padStart(2, '0');

const az = (s: string): number[] => Array.from(s, ch => ch.charCodeAt(0) - 65);
const FWD = ['EKMFLGDQVZNTOWYHXUSPAIBRCJ', 'AJDKSIRUXBLHWTMCQGZNPYVOEF', 'BDFHJLCPRTXVZNYEIWGAKMUSQO'].map(az);
const INV = FWD.map(f => {
  const a: number[] = [];
  f.forEach((v, i) => { a[v] = i; });
  return a;
});
const REFL = az('YRUHQSLDPXNGOKMIEBFZCWVJAT');
// Rotor III turns II over as it leaves V.
const NOTCH = 21;

/** Positions of the two stepping rotors: II in the middle, III on the right. */
export interface Rotors {
  middle: number;
  right: number;
}

/** One keypress' worth of stepping, which happens BEFORE the letter is
 *  enciphered, as on the real machine. */
export function stepRotors({ middle, right }: Rotors): Rotors {
  return { middle: right === NOTCH ? mod26(middle + 1) : middle, right: mod26(right + 1) };
}

/** Letter index (0–25) through III, II, I, the reflector, and back.
 *  `pos` is [I, II, III]. */
export function encipher(x: number, pos: readonly [number, number, number]): number {
  let c = x;
  for (let i = 2; i >= 0; i--) c = mod26(FWD[i]![mod26(c + pos[i]!)]! - pos[i]!);
  c = REFL[c]!;
  for (let i = 0; i < 3; i++) c = mod26(INV[i]![mod26(c + pos[i]!)]! - pos[i]!);
  return c;
}

/** The listener's message as typed so far. `hist` holds the rotors as they
 *  stood before each character, so a delete puts them back exactly. */
export interface Message {
  plain: string;
  cipher: string;
  hist: Rotors[];
  rotors: Rotors;
}

export const EMPTY_MESSAGE: Omit<Message, 'rotors'> = { plain: '', cipher: '', hist: [] };

/** A letter folded to the machine's alphabet: accents dropped, upper-cased,
 *  null for anything the lampboard has no bulb for. */
export function foldLetter(ch: string): string | null {
  const u = ch.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();
  return /^[A-Z]$/.test(u) ? u : null;
}

/** What a physical key types on the machine: a letter (accents folded, as
 *  typeInto does) or a digit, upper-cased; null for any other key, including
 *  named keys such as 'Enter' or 'Dead'. */
export function keyToChar(key: string): string | null {
  if (Array.from(key).length !== 1) return null;
  return /^[0-9]$/.test(key) ? key : foldLetter(key);
}

/** Type one character. Letters step the rotors and encipher; a space or a
 *  digit passes through as it is (the tape needs numbers for song titles; the
 *  machine never had them). Returns null when the keypress does nothing: the
 *  tape is full, a space would lead or double up, or the key isn't on the
 *  machine. `lamp` is the bulb the letter lights. */
export function typeInto(
  msg: Message,
  ch: string,
  vol: number,
): { msg: Message; lamp: string | null } | null {
  if (msg.plain.length >= MSG_MAX) return null;
  const hist = [...msg.hist, msg.rotors];
  if (ch === ' ') {
    if (!msg.plain || msg.plain.endsWith(' ')) return null;
    return { msg: { ...msg, plain: `${msg.plain} `, hist }, lamp: null };
  }
  if (/^[0-9]$/.test(ch)) {
    return { msg: { ...msg, plain: msg.plain + ch, cipher: msg.cipher + ch, hist }, lamp: null };
  }
  const letter = foldLetter(ch);
  if (!letter) return null;
  const rotors = stepRotors(msg.rotors);
  const lamp = chr(encipher(letter.charCodeAt(0) - 65, [vol, rotors.middle, rotors.right]));
  return {
    msg: { plain: msg.plain + letter, cipher: msg.cipher + lamp, hist, rotors },
    lamp,
  };
}

/** Undo the last character, rotors and all. */
export function deleteLast(msg: Message): Message {
  if (!msg.plain) return msg;
  const spaced = msg.plain.endsWith(' ');
  return {
    plain: msg.plain.slice(0, -1),
    cipher: spaced ? msg.cipher : msg.cipher.slice(0, -1),
    hist: msg.hist.slice(0, -1),
    rotors: msg.hist[msg.hist.length - 1] ?? msg.rotors,
  };
}

/** Cipher text in the radio operator's five-letter groups. */
export function groups(cipher: string): string {
  return (cipher.match(/.{1,5}/g) ?? []).join(' ');
}

/** What the lampboard spells while a song plays: the title, a rest, the
 *  artist, a longer rest, one entry per beat. An entry is the bulb to light,
 *  or null for a beat with no bulb (a rest, a digit, punctuation).
 *  `artistAt` is where the artist starts, so a skin can underline the
 *  character on the beat. Characters are code points, matching Array.from. */
export function lampSequence(title: string, artist: string): { seq: (string | null)[]; artistAt: number } {
  const t = Array.from(title).map(foldLetter);
  const a = Array.from(artist).map(foldLetter);
  if (!t.length && !a.length) return { seq: [], artistAt: 0 };
  const artistAt = t.length + 3;
  return { seq: [...t, null, null, null, ...a, null, null, null, null, null], artistAt };
}

/** Milliseconds per lampboard letter for a track's tempo: one per beat,
 *  folded by octaves into a readable 400–1000ms band, i.e. 60–150 BPM (a 170
 *  BPM reading spells on every other beat). */
export function beatMs(bpm: number | null | undefined): number {
  return 60_000 / foldBpm(bpm, 60, 150);
}

/** How fast the tape types a spoken line: spread over its estimated airtime
 *  so the last letter lands as the DJ stops, within readable bounds. */
export function typingMs(chars: number, airMs: number): number {
  if (chars <= 0) return 0;
  return Math.min(110, Math.max(28, airMs / chars));
}

/** A cheap deterministic scatter, for the tuning sweep's rotors and the
 *  scrambled title. Same inputs, same letter. */
export function scatter(j: number, s: number): number {
  let h = Math.imul(j + 1, 374761393) ^ Math.imul(s + 7, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return mod26((h ^ (h >>> 16)) >>> 0);
}

/** Volume (0–1) ↔ rotor I's position. */
export const volToStop = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * VOL_STOPS);
export const stopToVol = (x: number): number => Math.min(VOL_STOPS, Math.max(0, Math.round(x))) / VOL_STOPS;
