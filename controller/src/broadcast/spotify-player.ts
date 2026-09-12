// Reads the Spotify-mode markers (spotify-player.json, spotify-audio.json).
// The IO shell around spotify-player-pure.ts, same shape as music-starve.ts:
// synchronous readFileSync behind a short memo, every failure → null.

import { readFileSync } from 'node:fs';
import { STATE_DIR } from '../config.js';
import {
  parseSpotifyPlayerEvent,
  parseSpotifyAudioState,
  parseSpotifyEventFeed,
  type SpotifyPlayerEvent,
  type SpotifyAudioState,
} from './spotify-player-pure.js';

export type { SpotifyPlayerEvent, SpotifyAudioState };

export const SPOTIFY_PLAYER_FILE = `${STATE_DIR}/spotify-player.json`;
export const SPOTIFY_EVENTS_FILE = `${STATE_DIR}/spotify-events.jsonl`;
export const SPOTIFY_AUDIO_FILE = `${STATE_DIR}/spotify-audio.json`;

// New events since `afterSeq`, oldest first. The whole (short, rotated) file is
// read each time — cheaper than tracking byte offsets across the script's
// trims, and a 300-line file is nothing at 500 ms.
export function spotifyEventsSince(afterSeq: number): SpotifyPlayerEvent[] {
  try {
    return parseSpotifyEventFeed(readFileSync(SPOTIFY_EVENTS_FILE, 'utf8'), afterSeq);
  } catch {
    return [];
  }
}

const MEMO_MS = 250;
let playerMemo: { at: number; value: SpotifyPlayerEvent | null } | null = null;
let audioMemo: { at: number; value: SpotifyAudioState | null } | null = null;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null; // absent is the normal case before the first event
  }
}

export function currentSpotifyPlayerEvent(now: number = Date.now()): SpotifyPlayerEvent | null {
  if (playerMemo && now - playerMemo.at < MEMO_MS) return playerMemo.value;
  const value = parseSpotifyPlayerEvent(readJson(SPOTIFY_PLAYER_FILE));
  playerMemo = { at: now, value };
  return value;
}

export function currentSpotifyAudioState(now: number = Date.now()): SpotifyAudioState | null {
  if (audioMemo && now - audioMemo.at < MEMO_MS) return audioMemo.value;
  const value = parseSpotifyAudioState(readJson(SPOTIFY_AUDIO_FILE));
  audioMemo = { at: now, value };
  return value;
}
