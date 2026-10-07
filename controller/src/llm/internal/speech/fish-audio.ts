// Fish requires a model header and reference_id voices, and streams raw audio bytes.
// Keep its protocol here; cloud-speech.ts dispatches providers.

import { open, rename, unlink } from 'node:fs/promises';
import { resolveTtsOutPath } from '../../../audio/tts-out.js';
import { fetchWithTimeout } from '../../../util/fetch-timeout.js';

export const FISH_API_ORIGIN = 'https://api.fish.audio';
export const FISH_DEFAULT_MODEL = 's2.1-pro';
export const FISH_LATENCIES = ['low', 'normal', 'balanced'] as const;

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_DELAYS_MS = [250, 750] as const; // three total attempts
const MAX_RETRY_AFTER_MS = 1_000;
const MAX_ERROR_BODY = 500;
const MAX_VOICES = 500;
const PAGE_SIZE = 100;
// Hard page ceiling for voice discovery. `collected` only grows on trained TTS
// voices, so a server that reports `has_more: true` forever while returning
// only filtered-out items (ASR models, in-training voices) would otherwise
// loop until the route's outer abort. Twice the pages MAX_VOICES needs is
// enough slack for accounts whose voice list is mostly non-TTS models.
const MAX_PAGES = (MAX_VOICES / PAGE_SIZE) * 2;
const MAX_MP3_PROBE_BYTES = 1024 * 1024;

type FishLatency = (typeof FISH_LATENCIES)[number];

export interface FishTtsRequest {
  text: string;
  reference_id: string;
  format: 'mp3';
  temperature: number;
  top_p: number;
  latency: FishLatency;
  prosody: { speed: number };
}

interface FishTtsParams {
  text: string;
  referenceId: string;
  temperature?: number;
  topP?: number;
  latency?: string;
  speed?: number;
}

interface FishSynthesisParams extends FishTtsParams {
  apiKey: string;
  model?: string;
  outPath?: string;
}

export interface FishTransportOptions {
  /** Internal test seam. Production callers always use FISH_API_ORIGIN. */
  origin?: string;
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
  signal?: AbortSignal;
}

export interface FishVoice {
  id: string;
  label: string;
  hint?: string;
}

function cleanOrigin(origin?: string): string {
  return (origin || FISH_API_ORIGIN).trim().replace(/\/+$/, '');
}

function finiteInRange(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function cleanHeaderValue(value: unknown, field: string): string {
  const v = String(value || '').trim();
  if (!v || v.length > 100 || /[\r\n]/.test(v)) {
    throw new Error(`Fish Audio ${field} must be 1-100 characters`);
  }
  return v;
}

function cleanReferenceId(value: unknown): string {
  const v = String(value || '').trim();
  if (!v || v.length > 100) throw new Error('Fish Audio reference_id must be 1-100 characters');
  return v;
}

export function buildFishTtsRequest({ text, referenceId, temperature = 0.7, topP = 0.7, latency = 'normal', speed = 1 }: FishTtsParams): FishTtsRequest {
  const cleanText = String(text || '').trim();
  if (!cleanText) throw new Error('Empty TTS text');
  const cleanLatency = FISH_LATENCIES.includes(latency as FishLatency) ? latency as FishLatency : 'normal';
  return {
    text: cleanText,
    reference_id: cleanReferenceId(referenceId),
    format: 'mp3',
    temperature: finiteInRange(temperature, 0.7, 0, 1),
    top_p: finiteInRange(topP, 0.7, 0, 1),
    latency: cleanLatency,
    prosody: { speed: finiteInRange(speed, 1, 0.5, 2) },
  };
}

export function shouldRetryFishStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function retryDelayMs(res: Response, fallbackMs: number): number {
  const raw = res.headers.get('retry-after');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1000));
    }
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, fallbackMs));
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

// Retry backoffs must observe the caller's cancellation — a discarded preview
// should stop during the wait, not fire one more billable attempt after it.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function redactSecret(detail: string, secret: string): string {
  return secret ? detail.split(secret).join('[redacted]') : detail;
}

async function errorDetail(res: Response, secret = ''): Promise<string> {
  const raw = (await res.text().catch(() => '')).trim();
  if (!raw) return res.statusText || 'request failed';
  let message = raw;
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; detail?: unknown };
    message = typeof parsed.message === 'string'
      ? parsed.message
      : typeof parsed.detail === 'string'
        ? parsed.detail
        : raw;
  } catch {
    // Plain-text provider/proxy errors are valid detail too.
  }
  // Redact the complete upstream message BEFORE truncating it. Otherwise a key
  // crossing the 500-char boundary could leak a prefix that no longer matches
  // the full secret during replacement.
  return redactSecret(message, secret).slice(0, MAX_ERROR_BODY);
}

function assertMp3Response(res: Response): void {
  const contentType = (res.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  const accepted = contentType === 'audio/mpeg'
    || contentType === 'audio/mp3'
    || contentType === 'audio/x-mpeg'
    || contentType === 'application/octet-stream';
  if (!accepted) {
    throw new Error(`Fish Audio returned non-MP3 content (${contentType || 'missing content-type'})`);
  }
}

function mpegLayer3FrameLength(header: Buffer, offset: number): number | null {
  if (offset + 4 > header.length) return null;
  const b0 = header[offset];
  const b1 = header[offset + 1];
  const b2 = header[offset + 2];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  // Reserved MPEG version/layer/sample-rate values and free/bad bitrates are
  // not sufficient evidence of playable MP3 data.
  if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
    return null;
  }
  const mpeg1 = versionBits === 3;
  const bitrateKbps = (mpeg1
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[bitrateIndex];
  const sampleRates = versionBits === 3
    ? [44100, 48000, 32000]
    : versionBits === 2
      ? [22050, 24000, 16000]
      : [11025, 12000, 8000];
  const sampleRate = sampleRates[sampleRateIndex];
  return Math.floor(((mpeg1 ? 144 : 72) * bitrateKbps * 1000) / sampleRate) + padding;
}

function mp3FrameOffset(probe: Buffer): number | null {
  if (probe.length >= 3 && probe.subarray(0, 3).toString('ascii') === 'ID3') {
    if (probe.length < 10) return null;
    const sizeBytes = probe.subarray(6, 10);
    if ([...sizeBytes].some(v => (v & 0x80) !== 0)) return null;
    const tagSize = ((sizeBytes[0] << 21) | (sizeBytes[1] << 14) | (sizeBytes[2] << 7) | sizeBytes[3]) >>> 0;
    const footerSize = probe[3] === 4 && (probe[5] & 0x10) !== 0 ? 10 : 0;
    return 10 + tagSize + footerSize;
  }
  return 0;
}

function assertPlayableMp3Prefix(probe: Buffer, totalBytes: number): void {
  const firstOffset = mp3FrameOffset(probe);
  const firstLength = firstOffset == null ? null : mpegLayer3FrameLength(probe, firstOffset);
  const secondOffset = firstOffset != null && firstLength != null ? firstOffset + firstLength : null;
  const secondLength = secondOffset == null ? null : mpegLayer3FrameLength(probe, secondOffset);
  const validatedBytes = secondOffset != null && secondLength != null ? secondOffset + secondLength : 0;
  // Two consecutive complete frames distinguish real MP3 output from a lone
  // plausible header followed by truncation or proxy junk. Even the shortest
  // useful speech response spans more than two MPEG audio frames.
  if (!validatedBytes || validatedBytes > totalBytes || validatedBytes > probe.length) {
    throw new Error('Fish Audio returned invalid MP3 audio');
  }
}

async function streamResponseToFile(res: Response, outPath: string): Promise<void> {
  assertMp3Response(res);
  if (!res.body) throw new Error('Fish Audio returned no audio body');
  const tempPath = `${outPath}.fish-part-${process.pid}-${Date.now()}`;
  const file = await open(tempPath, 'w');
  let bytes = 0;
  const probeChunks: Buffer[] = [];
  let probeBytes = 0;
  try {
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const chunk = Buffer.from(value);
      bytes += chunk.byteLength;
      if (probeBytes < MAX_MP3_PROBE_BYTES) {
        const slice = chunk.subarray(0, MAX_MP3_PROBE_BYTES - probeBytes);
        probeChunks.push(slice);
        probeBytes += slice.byteLength;
      }
      await file.write(chunk);
    }
    await file.close();
    if (bytes === 0) throw new Error('Fish Audio returned an empty audio response');
    assertPlayableMp3Prefix(Buffer.concat(probeChunks, probeBytes), bytes);
    await rename(tempPath, outPath);
  } catch (err) {
    await file.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw err;
  }
}

export async function synthesizeFish({ apiKey, model = FISH_DEFAULT_MODEL, text, referenceId, temperature, topP, latency, speed, outPath: customPath }: FishSynthesisParams, transport: FishTransportOptions = {}): Promise<string> {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('Fish Audio API key not configured');
  const cleanModel = cleanHeaderValue(model, 'model');
  const request = buildFishTtsRequest({ text, referenceId, temperature, topP, latency, speed });
  const { outPath } = await resolveTtsOutPath(request.text, customPath, { ext: 'mp3' });
  const delays = transport.retryDelaysMs || DEFAULT_RETRY_DELAYS_MS;
  const attempts = delays.length + 1;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const res = await fetchWithTimeout(`${cleanOrigin(transport.origin)}/v1/tts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        model: cleanModel,
      },
      body: JSON.stringify(request),
      timeoutMs: transport.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      bodyDeadline: true,
      signal: transport.signal,
    });

    if (res.ok) {
      await streamResponseToFile(res, outPath);
      return outPath;
    }

    const detail = await errorDetail(res, key);
    if (!shouldRetryFishStatus(res.status) || attempt === attempts - 1) {
      throw new Error(`Fish Audio TTS failed (${res.status}): ${detail}`);
    }
    await sleep(retryDelayMs(res, delays[attempt] ?? 0), transport.signal);
  }

  throw new Error('Fish Audio TTS failed');
}

export function normalizeFishVoices(payload: unknown): FishVoice[] {
  if (!payload || typeof payload !== 'object') return [];
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const voices: FishVoice[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (row.type !== 'tts' || row.state !== 'trained') continue;
    const id = typeof row._id === 'string' ? row._id.trim() : '';
    if (!id || id.length > 100 || seen.has(id)) continue;
    seen.add(id);
    const label = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : id;
    const description = typeof row.description === 'string' ? row.description.trim() : '';
    const languages = Array.isArray(row.languages)
      ? row.languages.filter(v => typeof v === 'string').join(', ')
      : '';
    const hint = (description || languages).slice(0, 80);
    voices.push(hint ? { id, label, hint } : { id, label });
    if (voices.length >= MAX_VOICES) break;
  }
  return voices;
}

export async function listFishVoices(apiKey: string, transport: Pick<FishTransportOptions, 'origin' | 'timeoutMs' | 'signal'> = {}): Promise<FishVoice[]> {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('Fish Audio API key not set');
  const collected: FishVoice[] = [];

  for (let page = 1; collected.length < MAX_VOICES && page <= MAX_PAGES; page++) {
    const url = new URL(`${cleanOrigin(transport.origin)}/model`);
    url.searchParams.set('self', 'true');
    url.searchParams.set('page_size', String(PAGE_SIZE));
    url.searchParams.set('page_number', String(page));
    url.searchParams.set('sort_by', 'created_at');
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${key}` },
      timeoutMs: transport.timeoutMs ?? 10_000,
      bodyDeadline: true,
      signal: transport.signal,
    });
    if (!res.ok) {
      const detail = await errorDetail(res, key);
      throw new Error(`Fish Audio voice discovery failed (${res.status}): ${detail}`);
    }
    const payload = await res.json() as { total?: number; has_more?: boolean | null };
    const pageVoices = normalizeFishVoices(payload);
    for (const voice of pageVoices) {
      if (!collected.some(v => v.id === voice.id)) collected.push(voice);
      if (collected.length >= MAX_VOICES) break;
    }
    const total = Number(payload.total);
    const fetched = page * PAGE_SIZE;
    if (payload.has_more !== true && (!Number.isFinite(total) || fetched >= total)) break;
  }
  return collected;
}

export async function probeFishKey(apiKey: string, transport: Pick<FishTransportOptions, 'origin' | 'timeoutMs' | 'signal'> = {}): Promise<void> {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('Fish Audio API key not set');
  // Use the documented, read-only account voice endpoint rather than a wallet
  // route: validation stays non-billable and on the same public contract as
  // discovery. A one-item page is enough to authenticate the key.
  const url = new URL(`${cleanOrigin(transport.origin)}/model`);
  url.searchParams.set('self', 'true');
  url.searchParams.set('page_size', '1');
  url.searchParams.set('page_number', '1');
  const res = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${key}` },
    timeoutMs: transport.timeoutMs ?? 8_000,
    bodyDeadline: true,
    signal: transport.signal,
  });
  if (!res.ok) {
    const detail = await errorDetail(res, key);
    throw new Error(`Fish Audio key check failed (${res.status}): ${detail}`);
  }
  await res.arrayBuffer();
}
