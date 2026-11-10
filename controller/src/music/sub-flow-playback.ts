// One immutable local WAV is the playback unit. Raw-file fingerprints are
// checked against the saved definition before publishing any of its audio.
import { closeSync, fsyncSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { verifyTrack } from './sub-flow-verify.js';
import type { Flow } from './sub-flow.js';
import * as settings from '../settings.js';

export const FLOW_BUFFER_SEC = 5;
const RATE = 44100;
const FRAME_BYTES = 4;
const MAX_PCM_BYTES = 512 * 1024 * 1024;
let expected = false;
export function expectFlowPlayback(value: boolean) { expected = value; }
export function flowPlaybackExpected() { return expected; }

export interface FlowPlayback {
  occurrenceId: string;
  definitionId: string;
  revision: number;
  label: string;
  path: string;
  protectBeforeSec?: number;
  protectAfterSec?: number;
  members: { id: string; title: string; artist: string | null; album: string | null; duration: number }[];
}

export async function prepareFlow(flow: Flow): Promise<FlowPlayback> {
  const { flowProtectBeforeSec: protectBeforeSec, flowProtectAfterSec: protectAfterSec } = settings.get().picker;
  if (flow.verification !== 'verified' || !flow.orderVerified || flow.tracks.some(track => !track.fingerprint)) {
    throw new Error('Check the Flow audio and track order before queueing it.');
  }
  const root = join(config.stateDir, 'sub-flow-playback');
  await mkdir(root, { recursive: true });
  await chmod(root, 0o755);
  const dir = await mkdtemp(join(root, 'flow-'));
  const path = join(dir, 'audio.wav');
  let fd: number | undefined;
  let published = false;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, Buffer.alloc(44));
    let bytes = 0;
    const members: FlowPlayback['members'] = [];
    for (const track of flow.tracks) {
      const measured = await verifyTrack(track.id, track.duration, { onPcm: chunk => {
        bytes += chunk.length;
        if (bytes > MAX_PCM_BYTES) throw new Error('This Flow exceeds the prepared-audio size limit.');
        writeFileSync(fd!, chunk);
      } });
      const baseline = track.fingerprint!;
      if (measured.sha256 !== baseline.sha256 || measured.bytes !== baseline.bytes
          || Math.abs(measured.decodedSeconds - baseline.decodedSeconds) > 1 / RATE) {
        throw new Error(`The audio for “${track.title}” changed. Check the Flow again before queueing it.`);
      }
      members.push({ id: track.id, title: track.title, artist: track.artist, album: track.album, duration: measured.decodedSeconds });
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + bytes, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
    header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * FRAME_BYTES, 28);
    header.writeUInt16LE(FRAME_BYTES, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(bytes, 40);
    if (writeSync(fd, header, 0, header.length, 0) !== header.length) throw new Error('The prepared Flow could not be written completely.');
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    await chmod(path, 0o444);
    // Broadcast and controller can run as different users on the shared volume.
    await chmod(dir, 0o755);
    published = true;
    return { occurrenceId: randomUUID(), definitionId: flow.id, revision: flow.revision, label: flow.name, path, members, protectBeforeSec, protectAfterSec };
  } finally {
    if (fd != null) closeSync(fd);
    if (!published) await rm(dir, { recursive: true, force: true });
  }
}

export async function discardFlow(flow: Pick<FlowPlayback, 'path'>) {
  // The occurrence owns exactly this generated file, never a library recording.
  const path = resolve(flow.path);
  const dir = dirname(path);
  if (dirname(dir) !== resolve(config.stateDir, 'sub-flow-playback') || !basename(dir).startsWith('flow-') || basename(path) !== 'audio.wav') return;
  await rm(dir, { recursive: true, force: true });
}

export async function sweepFlowAudio(keep: string[]) {
  const root = join(config.stateDir, 'sub-flow-playback');
  const directories = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of directories) {
    if (!entry.isDirectory() || !entry.name.startsWith('flow-')) continue;
    const path = join(root, entry.name, 'audio.wav');
    if (keep.includes(path)) continue;
    const info = await stat(join(root, entry.name)).catch(() => null);
    if (info && info.mtimeMs < Date.now() - 2 * 3600_000) await discardFlow({ path });
  }
}

export function flowPlaybackUri(flow: FlowPlayback, crossSec: number) {
  const first = flow.members[0]!;
  const last = flow.members.at(-1)!;
  // Missing values belong to occurrences queued before configurable windows.
  const before = flow.protectBeforeSec ?? FLOW_BUFFER_SEC;
  const after = flow.protectAfterSec ?? FLOW_BUFFER_SEC;
  const fields: Record<string, string | number> = {
    title: first.title, artist: first.artist ?? '', album: first.album ?? '', subsonic_id: first.id,
    subwave_flow: flow.occurrenceId, subwave_flow_index: 0, subwave_flow_count: flow.members.length,
    subwave_flow_buffer: FLOW_BUFFER_SEC,
    subwave_flow_before: before, subwave_flow_after: after,
    subwave_flow_entry: Math.max(0, first.duration - before - 0.1),
    liq_cross_duration: Math.max(0, Math.min(crossSec, last.duration - after - 0.1)),
  };
  let offset = 0;
  flow.members.forEach((track, index) => {
    for (const key of ['id', 'title', 'artist', 'album', 'duration'] as const) fields[`subwave_flow_${index}_${key}`] = track[key] ?? '';
    fields[`subwave_flow_${index}_offset`] = offset;
    offset += track.duration;
  });
  return `annotate:${Object.entries(fields).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join(',')}:${flow.path}`;
}
