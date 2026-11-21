// Controller-owned show-airing memory. Tools read snapshots; only confirmed voice markers commit updates.
import { existsSync, readFileSync, statSync, renameSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { wavDurationMs } from '../broadcast/queue/voice-io.js';
import { config } from '../config.js';
import * as settings from '../settings.js';
import { zonedParts } from '../time.js';
import { resolveShowOccurrence } from '../broadcast/show-occurrence.js';
import { parseVoiceMarker, awaitVoiceAir, observeVoiceAir } from '../broadcast/queue/voice-marker.js';
import { writeFileAtomicSync } from '../util/atomic-file.js';
import { notebookFileSchema, notebookMemoryUpdateSchema, notebookRefSchema,
  NOTEBOOK_HISTORY_LIMIT, NOTEBOOK_AIRING_LIMIT,
  type NotebookFile, type NotebookEntry, type NotebookRef } from './notebook-schema.js';

const LEASE_MS = 20 * 60_000;
const registrations = new Map<string, { directory: string; enabled: boolean }>();
const voiceRefs = new Map<string, NotebookRef>();
let observingAir = false;
function forgetPending(entry: NotebookEntry) {
  for (const clip of entry.pending?.clips || []) voiceRefs.delete(clip.voiceId);
  entry.pending = null;
}
export function registerSkillNotebook(skill: string, directory: string, enabled: boolean) {
  registrations.set(skill, { directory, enabled });
  for (const [voiceId, ref] of voiceRefs) if (ref.skill === skill) voiceRefs.delete(voiceId);
  if (enabled && !observingAir) {
    observingAir = true;
    observeVoiceAir(marker => {
      const ref = voiceRefs.get(marker.voiceId);
      if (ref) notebookAir({ skillNotebook: ref }, marker.voiceId, marker.airedAt);
    });
  }
  if (enabled && existsSync(pathFor(skill))) {
    try {
      for (const entry of Object.values(load(skill).airings)) {
        const pending = entry.pending;
        if (pending) pending.clips.forEach((clip, index) => voiceRefs.set(clip.voiceId,
          { skill, occurrenceId: entry.occurrence.id, runId: pending.id, turn: index + 1, voiceId: clip.voiceId }));
      }
    } catch (error) { console.error(`[skills] notebook for ${skill} is unavailable: ${(error as Error).message}`); }
  }
}
function normalizedText(text: string) { return text.toLowerCase().replace(/[“”‘’"']/g, '').replace(/\s+/g, ' ').trim(); }
function nameWords(text: string) { return normalizedText(text.normalize('NFKC').replace(/[’']s\b/gi, '')).replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function contributorName(text: string) { return nameWords(text).replace(/^listener\s+/, ''); }
function pathFor(skill: string) {
  const registered = registrations.get(skill);
  if (!registered) throw new Error('skill notebook is not registered');
  return join(registered.directory, 'notebook.json');
}
function save(doc: NotebookFile) {
  notebookFileSchema.parse(doc);
  writeFileAtomicSync(pathFor(doc.skill), JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
}
function marker() {
  try { return parseVoiceMarker(readFileSync(config.liquidsoap.voicePlayingFile, 'utf8')); }
  catch { return null; }
}
function finish(entry: NotebookEntry) {
  if (entry.pending?.clips.length && entry.pending.clips.every(clip => clip.status === 'aired' || clip.status === 'cancelled')) forgetPending(entry);
}
function applyAir(entry: NotebookEntry, turn: number, voiceId: string, airedAt: number) {
  const pending = entry.pending;
  const clip = pending?.clips[turn - 1];
  if (!pending || !clip || clip.voiceId !== voiceId || clip.status === 'aired') return false;
  clip.status = 'aired'; clip.airedAt = airedAt; voiceRefs.delete(voiceId);
  const update = pending.update;
  if (update?.topic?.turn === turn && entry.topic === null) entry.topic = update.topic.value;
  for (const [index, contribution] of (update?.contributions || []).entries()) {
    if (contribution.turn !== turn) continue;
    const id = `${pending.id}:${index}`;
    if (entry.history.some(item => item.id === id)) continue;
    entry.history.push({ id, contributor: contribution.contributor, summary: contribution.summary, airedAt });
    entry.contributionCount += 1;
  }
  entry.history = entry.history.slice(-NOTEBOOK_HISTORY_LIMIT);
  entry.revision += 1;
  finish(entry);
  return true;
}
function load(skill: string): NotebookFile {
  const file = pathFor(skill);
  if (!existsSync(file)) return { version: 1, skill, airings: {} };
  if (statSync(file).size > 4 * 1024 * 1024) throw new Error('notebook.json is too large; restore a valid notebook or reset it explicitly');
  let doc: NotebookFile;
  try { doc = notebookFileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))); }
  catch { throw new Error('notebook.json is corrupt or unsupported; restore it or reset it explicitly'); }
  if (doc.skill !== skill) throw new Error('notebook.json belongs to another skill');
  const currentMarker = marker();
  let changed = false;
  for (const entry of Object.values(doc.airings)) {
    if (currentMarker) {
      const index = entry.pending?.clips.findIndex(clip => clip.voiceId === currentMarker.voiceId) ?? -1;
      if (index >= 0) changed = applyAir(entry, index + 1, currentMarker.voiceId, currentMarker.airedAt) || changed;
    }
    if (entry.pending && entry.pending.expiresAt <= Date.now()) { forgetPending(entry); changed = true; }
  }
  if (changed) save(doc);
  return doc;
}
function occurrenceNow() {
  const station = settings.get();
  const show = settings.getOnAirRoster().show;
  const occurrence = show ? resolveShowOccurrence({ at: Date.now(), showId: show.id, schedule: station.schedule,
    override: settings.getScheduleOverride(), parts: at => zonedParts(new Date(at)) }) : null;
  if (!occurrence) throw new Error('a show notebook requires an active scheduled show or takeover');
  return occurrence;
}
function entryFor(doc: NotebookFile, occurrence = occurrenceNow()) {
  if (!doc.airings[occurrence.id]) {
    const oldest = Object.values(doc.airings).sort((a, b) => a.occurrence.startsAt - b.occurrence.startsAt);
    while (Object.keys(doc.airings).length >= NOTEBOOK_AIRING_LIMIT) {
      const removable = oldest.find(entry => !entry.pending && doc.airings[entry.occurrence.id]);
      if (!removable) throw new Error('notebook retention is full of pending airings');
      delete doc.airings[removable.occurrence.id];
    }
    doc.airings[occurrence.id] = { occurrence, revision: 0, topic: null, contributionCount: 0, history: [], pending: null };
  }
  doc.airings[occurrence.id].occurrence = occurrence;
  return doc.airings[occurrence.id];
}
function snapshotOf(skill: string, entry: NotebookEntry) {
  return structuredClone({ skill, occurrence: entry.occurrence, revision: entry.revision, topic: entry.topic,
    contributionCount: entry.contributionCount, history: entry.history });
}
export function readSkillNotebook(skill: string) { return snapshotOf(skill, entryFor(load(skill))); }
export type NotebookSnapshot = ReturnType<typeof readSkillNotebook>;
export interface NotebookLease { skill: string; occurrenceId: string; runId: string; snapshot: NotebookSnapshot }
export function beginSkillNotebook(skill: string): NotebookLease {
  if (!registrations.get(skill)?.enabled) throw new Error('show notebook is not enabled for this skill');
  if (!marker()) throw new Error('show notebooks require valid confirmed mixer voice markers');
  const doc = load(skill); const entry = entryFor(doc);
  if (entry.pending) throw new Error('this skill already has a notebook segment generating or awaiting air');
  const runId = randomUUID();
  entry.pending = { id: runId, createdAt: Date.now(), expiresAt: Math.min(Date.now() + LEASE_MS, entry.occurrence.endsAt), revision: entry.revision, update: null, clips: [] };
  save(doc);
  return { skill, occurrenceId: entry.occurrence.id, runId, snapshot: snapshotOf(skill, entry) };
}
function pendingFor(ref: Pick<NotebookRef, 'skill' | 'occurrenceId' | 'runId'>) {
  const doc = load(ref.skill); const entry = doc.airings[ref.occurrenceId];
  return { doc, entry, pending: entry?.pending?.id === ref.runId ? entry.pending : null };
}
export function cancelNotebookRun(lease: Pick<NotebookLease, 'skill' | 'occurrenceId' | 'runId'>) {
  const { doc, entry, pending } = pendingFor(lease);
  if (!pending) return;
  // A published clip can still prove that it aired. Retain that receipt until resolved/expired.
  if (pending.clips.some(clip => clip.status === 'publishing')) {
    for (const clip of pending.clips) if (clip.status === 'staged' || clip.status === 'ready') clip.status = 'cancelled';
    finish(entry);
  } else forgetPending(entry);
  save(doc);
}
export function stageNotebook(lease: NotebookLease, updateValue: unknown, lines: Array<{ persona: { id: string; name?: string }; text: string }>) {
  const update = notebookMemoryUpdateSchema.parse(updateValue);
  const { doc, entry, pending } = pendingFor(lease);
  if (!pending || pending.revision !== lease.snapshot.revision || entry.revision !== lease.snapshot.revision) throw new Error('notebook lease expired or its revision changed');
  if (!lines.length || lines.length > 16) throw new Error('notebook segment must contain 1–16 turns');
  if (entry.topic === null && !update.topic) throw new Error('the first notebook segment must introduce a topic');
  if (entry.topic !== null && update.topic && update.topic.value !== entry.topic) throw new Error('the notebook topic is fixed for this airing');
  if (update.topic && (!lines[update.topic.turn - 1] || !normalizedText(lines[update.topic.turn - 1].text).includes(normalizedText(update.topic.value)))) {
    throw new Error('the proposed notebook topic must be spoken in its referenced turn');
  }
  const contributions = new Set(entry.history.map(item => JSON.stringify([contributorName(item.contributor), normalizedText(item.summary)])));
  for (const contribution of update.contributions) {
    const line = lines[contribution.turn - 1];
    if (!line) throw new Error('notebook contribution references a missing turn');
    if (entry.topic === null && update.topic && contribution.turn < update.topic.turn) throw new Error('a contribution cannot precede the first topic introduction');
    const name = contributorName(contribution.contributor);
    if (!name || (name !== contributorName(line.persona.name ?? '') && !` ${nameWords(line.text)} `.includes(` ${name} `))) {
      throw new Error('notebook contributor must be named in the referenced speech or be its presenter');
    }
    const key = JSON.stringify([name, normalizedText(contribution.summary)]);
    if (contributions.has(key)) throw new Error('notebook contribution duplicates an existing contributor and summary');
    contributions.add(key);
  }
  pending.update = update;
  pending.clips = lines.map(line => ({ voiceId: randomBytes(8).toString('hex'), text: line.text, personaId: line.persona.id,
    wavPath: null, meta: {}, status: 'staged', airedAt: null }));
  save(doc);
  return pending.clips.map((clip, index) => {
    const ref: NotebookRef = { skill: lease.skill, occurrenceId: lease.occurrenceId, runId: lease.runId, turn: index + 1, voiceId: clip.voiceId };
    voiceRefs.set(clip.voiceId, ref);
    return { skillNotebook: ref };
  });
}
function refOf(meta: Record<string, unknown> | undefined) {
  const parsed = notebookRefSchema.safeParse(meta?.skillNotebook);
  return parsed.success ? parsed.data : null;
}
export function notebookVoiceId(meta: Record<string, unknown> | undefined) { return refOf(meta)?.voiceId; }
export function notebookRendered(meta: Record<string, unknown> | undefined, wavPath: string, spokenText: string) {
  const ref = refOf(meta); if (!ref) return;
  if (!resolve(wavPath).startsWith(resolve(config.piper.outDir) + sep)) throw new Error('notebook WAV is outside the voice directory');
  const { doc, pending } = pendingFor(ref); const clip = pending?.clips[ref.turn - 1];
  if (!clip || clip.voiceId !== ref.voiceId) throw new Error('notebook segment expired before TTS completed');
  if (pending!.update?.topic?.turn === ref.turn && !normalizedText(spokenText).includes(normalizedText(pending!.update.topic.value))) throw new Error('the normalized speech no longer contains the proposed topic');
  clip.text = spokenText; clip.wavPath = wavPath; clip.meta = structuredClone(meta || {}); clip.status = 'ready'; save(doc);
}
export function notebookCanPublish(meta: Record<string, unknown> | undefined): boolean {
  const ref = refOf(meta); if (!ref) return true;
  if (!registrations.get(ref.skill)?.enabled) return false;
  const { doc, pending } = pendingFor(ref); const clip = pending?.clips[ref.turn - 1];
  if (!clip || clip.status !== 'ready' || occurrenceNow().id !== ref.occurrenceId) return false;
  if (pending!.clips.slice(0, ref.turn - 1).some(previous => previous.status !== 'aired')) return false;
  clip.status = 'publishing'; save(doc); return true;
}
export function notebookAir(meta: Record<string, unknown> | undefined, voiceId: string, airedAt: number | null) {
  const ref = refOf(meta); if (!ref || ref.voiceId !== voiceId) return;
  const { doc, entry, pending } = pendingFor(ref); if (!pending) return;
  if (airedAt === null) { cancelNotebookRun(ref); return; }
  if (applyAir(entry, ref.turn, voiceId, airedAt)) save(doc);
}
export function cancelNotebookClip(meta: Record<string, unknown> | undefined) {
  const ref = refOf(meta);
  if (ref) { try { cancelNotebookRun(ref); } catch (error) { console.error(`[skills] notebook cancellation failed: ${(error as Error).message}`); } }
}
export function resetSkillNotebook(skill: string, expectedRevision: number, expectedOccurrenceId?: string, discardCorrupt = false) {
  const occurrence = occurrenceNow();
  if (!discardCorrupt && !expectedOccurrenceId) throw new Error('expectedOccurrenceId is required to reset the current airing');
  if (expectedOccurrenceId && occurrence.id !== expectedOccurrenceId) throw new Error('the show airing changed; read the notebook again before resetting');
  let doc: NotebookFile;
  try { doc = load(skill); }
  catch (error) {
    if (!discardCorrupt || expectedRevision !== 0) throw error;
    const file = pathFor(skill);
    renameSync(file, `${file}.corrupt-${Date.now()}`);
    doc = { version: 1, skill, airings: {} };
  }
  const entry = entryFor(doc, occurrence);
  if (entry.revision !== expectedRevision) throw new Error('notebook revision changed; read it again before resetting');
  entry.topic = null; entry.history = []; entry.contributionCount = 0; forgetPending(entry); entry.revision += 1;
  save(doc); return snapshotOf(skill, entry);
}
export function skillNotebookStatus(skill: string) {
  const entry = entryFor(load(skill));
  return { notebook: snapshotOf(skill, entry), pending: entry.pending ? {
    runId: entry.pending.id, createdAt: entry.pending.createdAt, expiresAt: entry.pending.expiresAt,
    turns: entry.pending.clips.map((clip, index) => ({ turn: index + 1, status: clip.status })),
  } : null };
}
export function notebookPrompt(snapshot: NotebookSnapshot) {
  // The model needs continuity, not receipt IDs, epochs or persistence bookkeeping.
  const editorial = { topic: snapshot.topic, contributionCount: snapshot.contributionCount,
    history: snapshot.history.map(({ contributor, summary }) => ({ contributor, summary })) };
  return `\n\nShow skill notebook (committed facts from this skill and this airing only):\n${JSON.stringify(editorial)}\n\nReturn memoryUpdate separately from speech. It has topic: null or {value, turn}, and contributions: [{turn, contributor, summary}]. Turns are numbered from 1. If topic is empty, propose a fixed topic and speak that exact topic in its referenced turn. Otherwise retain the existing topic; use topic: null unless explicitly repeating it. The topic and history are continuity already heard on air, not source material to copy into this update. Continue the requested mode; do not treat an established topic as a first call or deny contributions already recorded. Record only NEW opinions or substantive points actually voiced in THIS segment. Topic introductions, repeated questions, invitations to contribute and routine acknowledgements are not contributions: use contributions: [] when there are no new points. Never copy history into updates or submit an already recorded contributor-and-summary pair. Name a quoted contributor in the turn that reads their opinion; use the full persona name for a presenter’s own opinion. Attach each item to the turn that actually voices that opinion, including when a presenter reads someone else’s words; an introduction or later reaction is not that turn. A solo segment has only turn 1; discussion indexes refer only to the returned lines, never history. Keep summaries concise and faithful, without adding an opinion or imagined future speech. Never read memoryUpdate, notebook fields or internal IDs aloud. Updates commit only when the corresponding turn reaches air.`;
}
export interface RecoveredNotebookSpeech { kind: string; createdAt: number; notBefore: number; clips: Array<{ text: string; wavPath: string; persona: ReturnType<typeof settings.get>['personas'][number]; meta: Record<string, unknown> }> }
export async function recoverSkillNotebooks(): Promise<RecoveredNotebookSpeech[]> {
  const recovered: RecoveredNotebookSpeech[] = [];
  await Promise.all([...registrations].map(async ([skill, registration]) => {
    if (!registration.enabled || !existsSync(pathFor(skill))) return;
    try {
      let doc = load(skill);
      for (const entry of Object.values(doc.airings)) {
        let pending = entry.pending; if (!pending) continue;
        const lease = { skill, occurrenceId: entry.occurrence.id, runId: pending.id };
        if (!registration.enabled || occurrenceNow().id !== entry.occurrence.id || !pending.clips.length || pending.clips.some(clip => clip.status === 'staged')) { cancelNotebookRun(lease); continue; }
        // Never republish an ambiguous handoff. Wait for its existing stable-ID marker.
        for (const [index, clip] of pending.clips.entries()) {
          if (clip.status !== 'publishing') continue;
          const airedAt = await awaitVoiceAir(clip.voiceId);
          notebookAir({ skillNotebook: { ...lease, turn: index + 1, voiceId: clip.voiceId } }, clip.voiceId, airedAt);
          if (airedAt === null) cancelNotebookRun(lease);
        }
        doc = load(skill); pending = doc.airings[entry.occurrence.id]?.pending;
        if (!pending) continue;
        if (pending.clips.some(clip => clip.status === 'publishing' || clip.status === 'cancelled')) { cancelNotebookRun(lease); continue; }
        const clips: RecoveredNotebookSpeech['clips'] = [];
        for (const [index, clip] of pending.clips.entries()) {
          if (clip.status === 'aired') continue;
          const persona = settings.get().personas.find(persona => persona.id === clip.personaId);
          if (!persona || !clip.wavPath || !existsSync(clip.wavPath) || !resolve(clip.wavPath).startsWith(resolve(config.piper.outDir) + sep)) { clips.length = 0; break; }
          clips.push({ text: clip.text, wavPath: clip.wavPath, persona,
            meta: { ...clip.meta, skillNotebook: { ...lease, turn: index + 1, voiceId: clip.voiceId } } });
        }
        if (clips.length) {
          const notBefore = Math.max(Date.now(), ...pending.clips.filter(clip => clip.airedAt !== null).map(clip => clip.airedAt! + (clip.wavPath ? wavDurationMs(clip.wavPath) || 90_000 : 90_000) + 1500));
          recovered.push({ kind: skill, createdAt: pending.createdAt, notBefore, clips });
        }
        else cancelNotebookRun(lease);
      }
    } catch (error) { console.error(`[skills] notebook recovery for ${skill} failed: ${(error as Error).message}`); }
  }));
  return recovered.sort((a, b) => a.createdAt - b.createdAt);
}
