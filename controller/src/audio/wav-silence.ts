// A tiny, dependency-free PCM WAV writer for pause-and-talk's silent music
// item. It lives on the shared state volume, so Liquidsoap can consume it as a
// normal request while the voice itself remains on the processed say queue.

import { readFileSync } from 'node:fs';
import { mkdir, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { writeFileAtomic } from '../util/atomic-file.js';

/** Where the silence items live. Its own directory so the sweep below can be an
 *  unconditional "everything in here is mine" — the state dir it sits in also
 *  holds session.json, the tag DB and the backup archive. */
export const PAUSE_TALK_DIR = `${config.stateDir}/pause-talk`;
export const PAUSE_TALK_COMMIT_FILE = `${PAUSE_TALK_DIR}/pending.json`;

// The queue owns the record's schema. This module owns only its atomic storage
// beside the silent WAVs, keeping the music handoff and its matching voice on
// the same durable state volume.
export async function writePauseTalkCommit(value: unknown): Promise<void> {
  await mkdir(PAUSE_TALK_DIR, { recursive: true });
  await writeFileAtomic(PAUSE_TALK_COMMIT_FILE, JSON.stringify(value, null, 2));
}

export function readPauseTalkCommit(): unknown | null {
  try {
    return JSON.parse(readFileSync(PAUSE_TALK_COMMIT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export async function discardPauseTalkCommit(): Promise<void> {
  try {
    await unlink(PAUSE_TALK_COMMIT_FILE);
  } catch {}
}

export async function writeSilentWav(path: string, durationMs: number, sampleRate = 44_100): Promise<void> {
  const frames = Math.max(1, Math.ceil((Math.max(0, durationMs) / 1000) * sampleRate));
  const dataBytes = frames * 2; // mono, signed 16-bit PCM
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVEfmt ', 8, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataBytes, 40);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, out);
}

// Reap spent silence items. These are ~3 MB apiece at 44.1 kHz/16-bit for a
// half-minute break, several an hour, and nothing else ever deletes them —
// cleanupOldVoices sweeps config.piper.outDir only. Age-based rather than
// unlinked at air time: the mixer still has the file open while it plays it.
//
// Per-file try/catch for the same reason as cleanupOldVoices: a file removed
// between readdir and stat must not abort the sweep and strand the rest.
export async function cleanupPauseTalkSilence(maxAgeMs = 60 * 60 * 1000): Promise<void> {
  let files: string[];
  try {
    files = await readdir(PAUSE_TALK_DIR);
  } catch {
    return;   // nothing written yet
  }
  const now = Date.now();
  for (const f of files) {
    if (!f.endsWith('.wav')) continue;
    const fp = join(PAUSE_TALK_DIR, f);
    try {
      const s = await stat(fp);
      if (now - s.mtimeMs > maxAgeMs) await unlink(fp);
    } catch {}
  }
}

/** Best-effort removal of a silence item that never made it to air. */
export async function discardSilentWav(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {}
}
