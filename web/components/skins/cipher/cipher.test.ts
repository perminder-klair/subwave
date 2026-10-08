// The Cipher skin claims its wiring is the real Enigma I's, so the claim is
// pinned against the machine's published test vector, and the typing rules the
// tape depends on (delete restores the rotors, spaces never lead or double)
// are pinned beside it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MSG_MAX,
  beatMs,
  chr,
  deleteLast,
  encipher,
  foldLetter,
  groups,
  lampSequence,
  stepRotors,
  typeInto,
  typingMs,
  volGlyph,
  type Message,
} from './cipher';

const blank = (m = 0, r = 0): Message => ({ plain: '', cipher: '', hist: [], rotors: { m, r } });

function typeAll(text: string, vol = 0, start = blank()): Message {
  let msg = start;
  for (const ch of text) {
    const next = typeInto(msg, ch, vol);
    if (next) msg = next.msg;
  }
  return msg;
}

test('rotors I-II-III at AAA with reflector B turn AAAAA into BDZGO', () => {
  assert.equal(typeAll('AAAAA').cipher, 'BDZGO');
});

test('enciphering is its own inverse and never maps a letter to itself', () => {
  for (const pos of [[0, 0, 0], [18, 10, 16], [25, 25, 25], [3, 21, 7]] as const) {
    for (let x = 0; x < 26; x++) {
      const c = encipher(x, pos);
      assert.notEqual(c, x);
      assert.equal(encipher(c, pos), x);
    }
  }
});

test('a message typed at the same setting reads back as the plain text', () => {
  const sent = typeAll('PLAY SOMETHING FOR THE NIGHT BUS', 18, blank(10, 16));
  const read = typeAll(sent.cipher, 18, blank(10, 16));
  assert.equal(read.plain, sent.cipher);
  assert.equal(read.cipher, sent.plain.replaceAll(' ', ''));
});

test('rotor III steps every letter and turns II over as it leaves V', () => {
  assert.deepEqual(stepRotors({ m: 4, r: 20 }), { m: 4, r: 21 });
  assert.deepEqual(stepRotors({ m: 4, r: 21 }), { m: 5, r: 22 });
  assert.deepEqual(stepRotors({ m: 25, r: 21 }), { m: 0, r: 22 });
  assert.deepEqual(stepRotors({ m: 0, r: 25 }), { m: 0, r: 0 });
});

test('delete restores the rotors and the cipher exactly', () => {
  const before = typeAll('NIGHT', 7, blank(3, 19));
  const after = deleteLast(typeAll('NIGHT B', 7, blank(3, 19)));
  assert.deepEqual(deleteLast(after), before);
  assert.deepEqual(deleteLast(blank()), blank());
});

test('a space never leads or doubles, and steps nothing', () => {
  assert.equal(typeInto(blank(), ' ', 0), null);
  const one = typeAll('HI ');
  assert.equal(typeInto(one, ' ', 0), null);
  assert.equal(one.plain, 'HI ');
  assert.equal(one.cipher.length, 2);
  assert.deepEqual(one.rotors, typeAll('HI').rotors);
});

test('digits pass through in the clear; other symbols do nothing', () => {
  const msg = typeAll('U2');
  assert.equal(msg.plain, 'U2');
  assert.equal(msg.cipher.at(-1), '2');
  assert.equal(typeInto(msg, '!', 0), null);
});

test('accented letters fold onto the machine alphabet', () => {
  assert.equal(foldLetter('é'), 'E');
  assert.equal(foldLetter('Ø'), null);
  assert.equal(foldLetter('ß'), null);
  assert.equal(typeAll('café').plain, 'CAFE');
});

test('the tape stops at its length', () => {
  const full = typeAll('A'.repeat(MSG_MAX + 5));
  assert.equal(full.plain.length, MSG_MAX);
  assert.equal(typeInto(full, 'B', 0), null);
});

test('cipher text prints in five-letter groups', () => {
  assert.equal(groups('ABCDEFGHIJKL'), 'ABCDE FGHIJ KL');
  assert.equal(groups(''), '');
});

test('the lampboard spells title, rest, artist, longer rest', () => {
  const { seq, artistAt } = lampSequence('Né 9', 'AB');
  assert.deepEqual(seq, ['N', 'E', null, null, null, null, null, 'A', 'B', null, null, null, null, null]);
  assert.equal(artistAt, 7);
  assert.deepEqual(lampSequence('', ''), { seq: [], artistAt: 0 });
});

test('the beat folds into a readable band by octaves', () => {
  assert.equal(Math.round(beatMs(null)), 652);
  assert.equal(beatMs(120), 500);
  assert.equal(beatMs(170), 60_000 / 170 * 2);
  assert.equal(beatMs(50), 600);
});

test('typing pace spreads a line over its airtime, within bounds', () => {
  assert.equal(typingMs(100, 6000), 60);
  assert.equal(typingMs(10, 6000), 110);
  assert.equal(typingMs(1000, 6000), 28);
  assert.equal(typingMs(0, 6000), 0);
});

test('rotor readouts', () => {
  assert.equal(chr(-1), 'Z');
  assert.equal(volGlyph(7), '07');
  assert.equal(volGlyph(26), '');
});
