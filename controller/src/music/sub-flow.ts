// The definition store is separate from the playback queue. Synchronous atomic
// writes make each read/modify/write one event-loop operation, including restore.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { writeFileAtomicSync } from '../util/atomic-file.js';
import * as subsonic from './subsonic.js';
import * as blocklist from './blocklist.js';
import { verifyTrack } from './sub-flow-verify.js';
import { subFlowInputSchema } from '../schemas/sub-flow.js';
import { albumNeighbours, assertAdjacent, orderedAlbumSongs } from './sub-flow-order.js';
import { renderJoin } from './sub-flow-preview.js';
import { prepareFlow, discardFlow } from './sub-flow-playback.js';

const trackSchema = z.object({
  id: z.string().min(1).max(128), title: z.string().min(1).max(500),
  artist: z.string().max(500).nullable(), album: z.string().max(500).nullable(),
  duration: z.number().positive().nullable(),
  fingerprint: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), decodedSeconds: z.number().positive(), bytes: z.number().int().positive() }).nullable(),
});
const flowSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(200), enabled: z.boolean(),
  revision: z.number().int().positive(), tracks: z.array(trackSchema).min(2).max(3),
  orderVerified: z.boolean().default(false),
  verification: z.enum(['pending', 'verified', 'failed']), verificationError: z.string().max(500).nullable(),
  createdAt: z.string(), updatedAt: z.string(),
});
const storeSchema = z.array(flowSchema).max(1000).superRefine((flows, ctx) => {
  const ids = new Set<string>();
  const enabledTracks = new Set<string>();
  for (const flow of flows) {
    if (flow.verification === 'verified' && flow.tracks.some(track => !track.fingerprint)) {
      ctx.addIssue({ code: 'custom', message: 'Verified Flow has missing fingerprints' });
    }
    if (ids.has(flow.id) || new Set(flow.tracks.map(track => track.id)).size !== flow.tracks.length) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate Flow or track' });
    }
    ids.add(flow.id);
    if (flow.enabled) for (const track of flow.tracks) {
      if (enabledTracks.has(track.id)) ctx.addIssue({ code: 'custom', message: 'Track belongs to multiple enabled Flows' });
      enabledTracks.add(track.id);
    }
  }
});
export type Flow = z.infer<typeof flowSchema>;

const file = join(config.stateDir, 'sub-flows.json');
const active = new Map<string, string>();
let generation = 0;
let queue = Promise.resolve();

function read(): Flow[] {
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return storeSchema.parse(JSON.parse(raw));
}
function write(flows: Flow[]) { writeFileAtomicSync(file, JSON.stringify(storeSchema.parse(flows), null, 2)); }
export function list(): Flow[] {
  return read().map(flow => flow.verification === 'pending' && !active.has(flow.id)
    ? { ...flow, verification: 'failed', verificationError: 'Verification was interrupted; check the Flow again.' }
    : flow);
}
export function validateBackup(data: unknown) { return storeSchema.parse(data); }
export function restore(data: unknown) {
  const flows = validateBackup(data).map(flow => ({ ...flow, orderVerified: false, verification: 'failed' as const, verificationError: 'Restored Flow needs verification.', tracks: flow.tracks.map(track => ({ ...track, fingerprint: null })) }));
  generation++;
  active.clear();
  write(flows);
}

function schedule(flow: Flow) {
  const token = randomUUID();
  active.set(flow.id, token);
  const startedGeneration = generation;
  const work = queue.then(async () => {
    try {
      if (generation !== startedGeneration || active.get(flow.id) !== token) return;
      const fingerprints: Awaited<ReturnType<typeof verifyTrack>>[] = [];
      for (const track of flow.tracks) fingerprints.push(await verifyTrack(track.id, track.duration));
      updateResult(flow, startedGeneration, fingerprints, null);
    } catch (error) {
      updateResult(flow, startedGeneration, null, error instanceof Error ? error.message.slice(0, 500) : 'Verification failed');
    } finally {
      // A newer revision may have its own queued verification.
      if (active.get(flow.id) === token) active.delete(flow.id);
    }
  });
  queue = work.catch(() => { console.error('[sub-flow] Could not save the verification result'); });
}
function updateResult(flow: Flow, startedGeneration: number, fingerprints: Awaited<ReturnType<typeof verifyTrack>>[] | null, error: string | null) {
  if (generation !== startedGeneration) return;
  const flows = read();
  const index = flows.findIndex(item => item.id === flow.id && item.revision === flow.revision);
  if (index < 0) return;
  flows[index] = { ...flow, verification: fingerprints ? 'verified' : 'failed', verificationError: error,
    tracks: flow.tracks.map((track, i) => ({ ...track, fingerprint: fingerprints?.[i] ?? null })) };
  write(flows);
}

export async function albumTracks(albumId: string) {
  await blocklist.load();
  const result = await subsonic.getAlbumWithSongs(albumId, { requireComplete: true });
  if (!result) throw new Error('The complete album track list is unavailable');
  const ordered = orderedAlbumSongs(albumId, result.album);
  const allowed = new Set(result.songs.map(song => song.id));
  let order = -1;
  return ordered.flatMap((song, index) => {
    order += index > 0 && !albumNeighbours(ordered[index - 1]!, song) ? 2 : 1;
    return allowed.has(song.id) ? [{ ...song, order }] : [];
  });
}

async function checkTrackOrder(ids: string[], songs: any[]) {
  if (songs.length !== ids.length || songs.some((song, i) => !song || song.id !== ids[i] || subsonic.isStationArchive(song) || blocklist.hitOf(song))) {
    throw new Error('A selected track is missing or blocked');
  }
  const albumId = songs[0]?.albumId;
  if (typeof albumId !== 'string' || !albumId || songs.some(song => song?.albumId !== albumId)) {
    throw new Error('Flow tracks must be consecutive tracks from the same album, in album order');
  }
  const album = await subsonic.getAlbumWithSongs(albumId, { requireComplete: true });
  if (!album) throw new Error('The complete album track list is unavailable');
  assertAdjacent(ids, orderedAlbumSongs(albumId, album.album));
}

let previewBusy = false;
let preparingPlayback = false;
export async function preparePlayback(id: string, revision: number) {
  const startedGeneration = generation;
  if (preparingPlayback) throw new Error('A Flow is already being prepared. Try again shortly.');
  const flow = read().find(item => item.id === id);
  if (!flow || flow.revision !== revision) throw new Error('This Flow changed or was deleted; reload before queueing it.');
  if (!flow.enabled) throw new Error('Enable the Flow before queueing it.');
  preparingPlayback = true;
  try {
    await blocklist.load();
    await checkTrackOrder(flow.tracks.map(track => track.id), await Promise.all(flow.tracks.map(track => subsonic.getSong(track.id))));
    const prepared = await prepareFlow(flow);
    const current = read().find(item => item.id === id);
    if (generation !== startedGeneration || !current?.enabled || current.revision !== revision) {
      await discardFlow(prepared);
      throw new Error('This Flow changed while its audio was being prepared. Queue it again.');
    }
    return prepared;
  } finally { preparingPlayback = false; }
}
export async function previewJoin(input: unknown, signal: AbortSignal) {
  const ids = z.array(z.string().min(1).max(128)).length(2).parse(input);
  if (previewBusy) throw new Error('Another join preview is being prepared. Try again shortly.');
  previewBusy = true;
  try {
    await blocklist.load();
    const songs = await Promise.all(ids.map(id => subsonic.getSong(id)));
    await checkTrackOrder(ids, songs);
    signal.throwIfAborted();
    return await renderJoin(songs.map(song => ({ id: song.id, duration: Number(song.duration) > 0 ? Number(song.duration) : null })), signal);
  } finally { previewBusy = false; }
}

export async function save(id: string | null, input: unknown): Promise<Flow> {
  const startedGeneration = generation;
  const parsed = subFlowInputSchema.parse(input);
  await blocklist.load();
  const songs = await Promise.all(parsed.trackIds.map(trackId => subsonic.getSong(trackId)));
  const tracks = songs.map((song, index) => {
    if (!song || song.id !== parsed.trackIds[index] || !song.title || subsonic.isStationArchive(song)) throw new Error('A selected track is missing from the library');
    if (blocklist.hitOf(song)) throw new Error(`A selected track is blocked: ${song.title}`);
    return trackSchema.parse({ id: song.id, title: song.title, artist: song.artist ?? null, album: song.album ?? null,
      duration: Number(song.duration) > 0 ? Number(song.duration) : null, fingerprint: null });
  });
  await checkTrackOrder(parsed.trackIds, songs);
  if (generation !== startedGeneration) throw new Error('Flows were restored; reload before saving');
  const flows = read();
  const old = id ? flows.find(flow => flow.id === id) : undefined;
  if (id && (!old || old.revision !== parsed.revision)) throw new Error('This Flow changed or was deleted; reload before saving');
  if (parsed.enabled && flows.some(flow => flow.id !== id && flow.enabled && flow.tracks.some(track => parsed.trackIds.includes(track.id)))) throw new Error('A track already belongs to another enabled Flow');
  if (!id && flows.length >= 1000) throw new Error('The Flow limit has been reached');
  const now = new Date().toISOString();
  const flow: Flow = { id: old?.id ?? randomUUID(), name: parsed.name, enabled: parsed.enabled, tracks,
    revision: (old?.revision ?? 0) + 1, orderVerified: true, verification: 'pending', verificationError: null, createdAt: old?.createdAt ?? now, updatedAt: now };
  write(old ? flows.map(item => item.id === id ? flow : item) : [...flows, flow]);
  schedule(flow);
  return flow;
}

export function remove(id: string, revision: number) {
  const flows = read();
  const old = flows.find(flow => flow.id === id);
  if (!old || old.revision !== revision) throw new Error('This Flow changed or was deleted; reload before deleting');
  write(flows.filter(flow => flow.id !== id));
}

export async function setEnabled(id: string, revision: number, enabled: boolean) {
  const startedGeneration = generation;
  if (enabled) {
    const initial = read().find(flow => flow.id === id);
    if (!initial || initial.revision !== revision) throw new Error('This Flow changed or was deleted; reload before changing it');
    const ids = initial.tracks.map(track => track.id);
    await blocklist.load();
    const songs = await Promise.all(ids.map(trackId => subsonic.getSong(trackId)));
    await checkTrackOrder(ids, songs);
  }
  if (generation !== startedGeneration) throw new Error('Flows were restored; reload before changing this Flow');
  const flows = read();
  const index = flows.findIndex(flow => flow.id === id);
  const old = flows[index];
  if (!old || old.revision !== revision) throw new Error('This Flow changed or was deleted; reload before changing it');
  if (enabled && flows.some(flow => flow.id !== id && flow.enabled && flow.tracks.some(track => old.tracks.some(member => member.id === track.id)))) throw new Error('A track already belongs to another enabled Flow');
  const flow: Flow = { ...old, enabled, orderVerified: enabled ? true : old.orderVerified, revision: old.revision + 1, updatedAt: new Date().toISOString(),
    verification: old.verification === 'pending' ? 'failed' : old.verification,
    verificationError: old.verification === 'pending' ? 'Verification was interrupted; check the Flow again.' : old.verificationError };
  flows[index] = flow;
  write(flows);
  active.delete(id);
  return flow;
}
