// Text-embedding layer for the library tagger. formatTrackText is the single
// canonical embed-text shape — seeds, propagation and similarity queries all
// go through it.

import { embedMany } from 'ai';
import {
  embeddingModel,
  activeEmbeddingModelLabel,
  activeEmbeddingDim,
  embeddingEnabled,
  embeddingProviderInfo,
  embeddingInfoOf,
  resolveEmbeddingCfg,
  buildEmbeddingModel,
  isHeavyEmbeddingModel,
  isLocalEmbeddingProvider,
  embeddingTextPrefixes,
} from '../llm/provider.js';
import type { EmbeddingCfg, EmbeddingTextPrefixes } from '../llm/provider.js';
import { moodVocab } from '../settings.js';
import crypto from 'node:crypto';

const LYRIC_EXCERPT_CHARS = 400; // cap lyrics before they bloat the embedding text

export interface SongMeta {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  year?: number | string | null;
  genres?: string[] | null;
  genre?: string | null;
  // Resolved by the caller via show-filter.resolveEraYear, never raw `year`.
  eraYear?: number | null;
}

export interface TrackEnrichment {
  lastfmTags?: string[] | null;
  lyricExcerpt?: string | null;
}

// Measured acoustics from the analyzer pass (#1246). Never the tagger's own
// `moods` / `energy`: those are decided from these vectors, so feeding them
// back is circular.
export interface TrackAcoustics {
  bpm?: number | null;
  musicalKey?: string | null;      // Camelot code, e.g. '8A'
  // Zero-shot CLAP moods (music/audio-moods.ts). Heavy analyzer tier only.
  audioMoods?: string[] | null;
  // tracks.vocal_ranges. [] = measured instrumental, non-empty = has vocals,
  // null/undefined = not computed.
  vocalRanges?: unknown[] | null;
  // The pace curve is deliberately not an input: its range (~0.02–0.5) makes a
  // fixed threshold stamp one word on ~everything.
}

// Bump when formatTrackText's output shape moves vectors. Recorded in
// embedding_meta.text_format; legacy rows read as 1.
//   1  head line + Last.fm tags + lyric excerpt
//   2  ... + the Sound: descriptor line + the Era: decade line (#1246)
export const EMBED_TEXT_VERSION = 2;

// Tempo as a word, not a number: "128" embeds as an arbitrary token.
function tempoWord(bpm: number): string | null {
  if (!Number.isFinite(bpm) || bpm <= 0) return null;   // 0 = unknown, never "very slow"
  if (bpm < 80) return 'slow tempo';
  if (bpm < 105) return 'mid-tempo';
  if (bpm < 130) return 'upbeat tempo';
  return 'fast tempo';
}

// Only the mode of a Camelot code is legible ('A' = minor, 'B' = major); the
// tonic number stays out. Positions outside 1-12 yield null.
function keyModeWord(camelot: string): string | null {
  const m = /^\s*(?:[1-9]|1[0-2])\s*([AB])\s*$/i.exec(camelot);
  if (!m) return null;
  return m[1].toUpperCase() === 'A' ? 'minor key' : 'major key';
}

// Descriptor words for a track's measured sound, in a stable order (the same
// input must always produce the same vector). Empty when nothing was analysed.
export function soundDescriptors(acoustics?: TrackAcoustics | null): string[] {
  if (!acoustics) return [];
  const words: string[] = [];
  for (const m of acoustics.audioMoods ?? []) {
    const t = String(m || '').trim();
    if (t) words.push(t);
  }
  const tempo = acoustics.bpm != null ? tempoWord(Number(acoustics.bpm)) : null;
  if (tempo) words.push(tempo);
  const mode = acoustics.musicalKey ? keyModeWord(acoustics.musicalKey) : null;
  if (mode) words.push(mode);
  // [] is a measurement ("no vocals found"), null is its absence.
  if (Array.isArray(acoustics.vocalRanges) && acoustics.vocalRanges.length === 0) {
    words.push('instrumental');
  }
  return words;
}

// The Era line's decade word ('1990s'). Input is the resolved era year, never
// raw `year`. Sub-millennium years are junk tags, not ancient recordings.
export function decadeWord(eraYear?: number | null): string | null {
  const y = Number(eraYear);
  if (!Number.isFinite(y) || y < 1000) return null;
  return `${Math.floor(y / 10) * 10}s`;
}

export function isAvailable(): boolean {
  if (!embeddingEnabled()) return false;
  try {
    embeddingModel();
    return true;
  } catch {
    return false;
  }
}

export function activeModelLabel(): string {
  return activeEmbeddingModelLabel();
}

export interface EmbeddingPerfAdvisory {
  model: string;
  provider: string;
  local: boolean;
  // Large + slow on CPU relative to the light default (nomic-embed-text).
  heavy: boolean;
}

// Drives the doctor's "embedding model" advisory; `local` gates the warning.
// Pure + name-based: never probes, never throws.
export function embeddingPerfAdvisory(): EmbeddingPerfAdvisory {
  const { provider, model } = embeddingProviderInfo();
  return {
    model,
    provider,
    local: isLocalEmbeddingProvider(provider),
    heavy: isHeavyEmbeddingModel(model),
  };
}

// library.ts needs the schema dim on first open, before any embedding call.
export function resolveEmbeddingDim(): number {
  return activeEmbeddingDim();
}

// Canonical text shape — one function so every consumer produces the same
// vector for the same input. Head line, then optional `Last.fm:` / `Lyrics:` /
// `Sound:` / `Era:` lines. An optional line is omitted when its signal is
// absent, never emitted empty: a constant label clusters exactly the tracks it
// says nothing about.
export function formatTrackText(
  song: SongMeta,
  enrich?: TrackEnrichment | null,
  acoustics?: TrackAcoustics | null,
): string {
  // All genre tags, comma-joined; never just genres[0].
  const genre = song.genres?.length ? song.genres.join(', ') : song.genre;
  const head =
    `${song.artist || 'Unknown Artist'} — ${song.title || 'Unknown Title'} ` +
    `· ${song.album || 'Unknown Album'} (${song.year ?? '?'}) [${genre || '?'}]`;
  const lines = [head];
  if (enrich?.lastfmTags && enrich.lastfmTags.length) {
    lines.push(`Last.fm: ${enrich.lastfmTags.join(', ')}`);
  }
  if (enrich?.lyricExcerpt) {
    const trimmed = enrich.lyricExcerpt.slice(0, LYRIC_EXCERPT_CHARS).replace(/\s+/g, ' ').trim();
    if (trimmed) lines.push(`Lyrics: ${trimmed}`);
  }
  const sound = soundDescriptors(acoustics);
  if (sound.length) lines.push(`Sound: ${sound.join(', ')}`);
  // Era is label-derived, not measured, so it gets its own line and
  // labelOnlyVectorCount does not count it as musical signal (#1246).
  const decade = decadeWord(song.eraYear);
  if (decade) lines.push(`Era: ${decade}`);
  return lines.join('\n');
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const model = embeddingModel();
  const { embeddings } = await embedMany({ model, values: texts });
  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
    throw new Error(
      `embedMany returned ${embeddings?.length ?? 'no'} vectors for ${texts.length} texts`,
    );
  }
  return embeddings as number[][];
}

// Task prefixes: some models (nomic-embed-text, the default) need
// `search_document:` on indexed texts and `search_query:` on queries. Document
// prefixes change the stored vectors, so the index records its mode in
// embedding_meta.text_mode and every query embed must match it.

export type IndexTextMode = 'plain' | 'prefixed';

function activePrefixes(): EmbeddingTextPrefixes {
  return embeddingTextPrefixes(embeddingProviderInfo().model);
}

// The mode a fresh index should be built in for the active model.
export function preferredTextMode(): IndexTextMode {
  return activePrefixes().document ? 'prefixed' : 'plain';
}

// Mode of an existing index. Stored mode always wins: a prefixed query against
// bare documents is worse than bare-vs-bare. A populated index with no recorded
// mode was embedded bare; an empty one adopts the preferred mode.
export function resolveIndexTextMode(
  stored: IndexTextMode | null | undefined,
  vectorCount: number,
): IndexTextMode {
  if (stored) return stored;
  if (vectorCount > 0) return 'plain';
  return preferredTextMode();
}

// What text format the index is recorded as (#1246): the oldest shape still
// present, since a forward run embeds only vectorless tracks and leaves a mix.
// Recording the current one would erase the signal that a re-embed is worth
// running. `reseed` rewrites every vector, so it always adopts.
export function resolveIndexTextFormat(
  stored: number | null | undefined,
  vectorCount: number,
  reseed = false,
): number {
  if (reseed) return EMBED_TEXT_VERSION;
  if (vectorCount > 0) return Math.min(stored ?? 1, EMBED_TEXT_VERSION);
  return EMBED_TEXT_VERSION;
}

// Pure prefix application, exported for tests.
export function applyDocPrefix(
  text: string,
  mode: IndexTextMode,
  prefixes: EmbeddingTextPrefixes = activePrefixes(),
): string {
  return mode === 'prefixed' && prefixes.document ? prefixes.document + text : text;
}

// A query prefix applies when the index carries document prefixes too, or when
// the model prefixes queries only (mxbai-style: documents embed bare by design,
// so the index mode doesn't gate it).
export function applyQueryPrefix(
  text: string,
  indexMode: IndexTextMode,
  prefixes: EmbeddingTextPrefixes = activePrefixes(),
): string {
  if (!prefixes.query) return text;
  if (!prefixes.document || indexMode === 'prefixed') return prefixes.query + text;
  return text;
}

// Embed texts destined for the index (tracks). `mode` is the index's mode —
// callers get it from embedding_meta via resolveIndexTextMode.
export function embedDocTexts(texts: string[], mode: IndexTextMode): Promise<number[][]> {
  return embedTexts(texts.map(t => applyDocPrefix(t, mode)));
}

// Embed a search query against an index built in `indexMode`. Returns null
// when the provider comes back empty (callers already handle a missing vector).
export async function embedQueryText(
  text: string,
  indexMode: IndexTextMode,
): Promise<number[] | null> {
  const [vec] = await embedTexts([applyQueryPrefix(text, indexMode)]);
  return vec ?? null;
}

// Preflight: classify the common configuration failures before running a whole
// embedding job, so the operator gets an actionable message (#174).

type ProbeCode =
  | 'ok'
  | 'disabled'
  | 'not_found'           // Ollama 404 — model isn't pulled
  | 'unauthorized'        // 401 — typically cloud-routed Ollama or wrong API key
  | 'unreachable'         // connection refused / DNS / timeout
  | 'not_embedding_model' // server reached, but it's a chat model / no pooling (#319)
  | 'no_embeddings'       // provider is chat-only — no embeddings endpoint at all (#493)
  | 'bad_url'             // baseUrl missing/malformed — fetch can't parse the URL
  | 'unknown';            // anything else — message has the raw error

export interface ProbeResult {
  code: ProbeCode;
  message: string;
  // Measured vector length, beating the model-name guess (#319). Only set when
  // code == 'ok'.
  dim?: number;
  // Resolved embedding provider ("follow LLM" already resolved).
  provider?: string;
}

function classifyEmbeddingError(err: any): { code: ProbeCode; raw: string } {
  const raw = err?.message || String(err);
  const status = err?.cause?.status_code ?? err?.statusCode ?? err?.status;
  const txt = raw.toLowerCase();
  // Chat-only providers (deepseek / gateway) throw this from
  // buildEmbeddingModel (#493). Must be checked before the network-shaped
  // codes: it's a config error, not a reachability one.
  if (txt.includes('has no text-embedding support')) {
    return { code: 'no_embeddings', raw };
  }
  if (status === 404 || txt.includes('not found') || txt.includes('try pulling')) {
    return { code: 'not_found', raw };
  }
  if (status === 401 || status === 403 || txt.includes('unauthorized') || txt.includes('forbidden')) {
    return { code: 'unauthorized', raw };
  }
  // Server is up and authenticated, but the loaded model can't embed: usually an
  // openai-compatible embedding config inheriting the chat server's baseUrl,
  // whose pooling type is 'none' (#319).
  if (
    txt.includes('does not support embeddings') ||
    txt.includes('start it with') ||         // llama.cpp: "Start it with `--embeddings`"
    txt.includes('pooling')                  // llama.cpp: "Pooling type 'none' is not OAI compatible"
  ) {
    return { code: 'not_embedding_model', raw };
  }
  if (
    err?.code === 'ECONNREFUSED' ||
    err?.cause?.code === 'ECONNREFUSED' ||
    err?.code === 'ENOTFOUND' ||
    err?.cause?.code === 'ENOTFOUND' ||
    txt.includes('fetch failed')
  ) {
    return { code: 'unreachable', raw };
  }
  // A missing/malformed base URL makes the SDK build a relative request URL,
  // which fetch rejects before any network call.
  if (
    txt.includes('failed to parse url') ||
    txt.includes('invalid url') ||
    txt.includes('no embedding server url is set')
  ) {
    return { code: 'bad_url', raw };
  }
  return { code: 'unknown', raw };
}

function actionableMessage(
  code: ProbeCode,
  raw: string,
  info: { provider: string; model: string; ollamaUrl: string },
): string {
  const { provider, model, ollamaUrl } = info;
  switch (code) {
    case 'not_found':
      if (provider === 'ollama') {
        return (
          `Embedding model "${model}" isn't installed in your Ollama at ${ollamaUrl}.\n` +
          `  Fix:  ollama pull ${model}\n` +
          `  Or pick another model in /admin/settings → Embedding (e.g. nomic-embed-text).`
        );
      }
      return (
        `Embedding model "${model}" was not found on provider "${provider}".\n` +
        `  Pick a different model in /admin/settings → Embedding.`
      );
    case 'unauthorized':
      if (provider === 'ollama') {
        return (
          `Ollama at ${ollamaUrl} returned "unauthorized" for embedding model "${model}".\n` +
          `  This usually means your Ollama is routing the request to ollama.com\n` +
          `  (cloud), which doesn't expose embeddings the same way as chat.\n` +
          `  Fix:  pull a LOCAL embedding model and point settings.embedding at it:\n` +
          `        ollama pull nomic-embed-text\n` +
          `        # then in /admin/settings → Embedding set model = nomic-embed-text`
        );
      }
      return (
        `Provider "${provider}" rejected the embedding request as unauthorized.\n` +
        `  Check settings.embedding.apiKey (or the inherited llm.apiKey).`
      );
    case 'unreachable':
      if (provider === 'ollama') {
        return (
          `Can't reach Ollama at ${ollamaUrl}.\n` +
          `  Is the server running? In Docker, the controller reaches the host via\n` +
          `  http://host.docker.internal:11434 — set settings.embedding.ollamaUrl\n` +
          `  (or settings.llm.ollamaUrl, which embeddings inherit from) accordingly.`
        );
      }
      return `Can't reach provider "${provider}" — check network / baseUrl. (${raw})`;
    case 'no_embeddings':
      return (
        `Provider "${provider}" is chat-only — it has no embeddings endpoint, so the\n` +
        `  library tagger can't use it. (The DJ still works on "${provider}".)\n` +
        `  Pick an embedding-capable provider in /admin/settings → Embedding:\n` +
        `    • Ollama   — local + free (ollama pull nomic-embed-text; auto-pulled)\n` +
        `    • OpenAI / Google / OpenRouter — cloud (needs the matching API key)\n` +
        `    • locca / openai-compatible — your own embedding server`
      );
    case 'not_embedding_model':
      if (provider === 'openai-compatible' || provider === 'locca') {
        const startCmd =
          provider === 'locca'
            ? `        locca embed nomic     # dedicated embedding server on its own port`
            : `        llama-server -m nomic-embed-text-v1.5.Q8_0.gguf \\\n` +
              `          --embeddings --pooling mean --host 0.0.0.0 --port 8090`;
        return (
          `The embedding endpoint is reachable but "${model}" can't produce embeddings —\n` +
          `  it's a chat/generative model, not an embedding model.\n` +
          `  By default settings.embedding inherits settings.llm.baseUrl, so embeddings\n` +
          `  point at your CHAT server. A single llama.cpp/locca server can't do both —\n` +
          `  run a DEDICATED embedding server (note --embeddings --pooling mean):\n` +
          startCmd + `\n` +
          `  then in /admin/settings → Embedding set:\n` +
          `        baseUrl = http://<host>:8090/v1   (the embedding server's URL)\n` +
          `        model   = nomic-embed-text\n` +
          `  (server said: ${raw})`
        );
      }
      return (
        `The embedding endpoint is reachable but "${model}" can't produce embeddings —\n` +
        `  it looks like a chat/generative model, not an embedding model.\n` +
        `  Point settings.embedding at a real embedding model (e.g. nomic-embed-text),\n` +
        `  served with embeddings enabled and a pooling type other than 'none'.\n` +
        `  (server said: ${raw})`
      );
    case 'bad_url':
      if (provider === 'locca' || provider === 'openai-compatible') {
        return (
          `No usable embedding server URL for provider "${provider}".\n` +
          `  By default settings.embedding inherits settings.llm — but a chat\n` +
          `  llama.cpp/locca server can't also do embeddings. Run a DEDICATED\n` +
          `  embedding server and point settings.embedding.baseUrl at it:\n` +
          `        locca embed nomic     # dedicated embedding server on its own port\n` +
          `  then in /admin/settings → Embedding set:\n` +
          `        baseUrl = http://<host>:8090/v1   (full URL, with http:// and /v1)\n` +
          `        model   = nomic-embed-text\n` +
          `  (${raw})`
        );
      }
      return (
        `The embedding server base URL is missing or malformed, so the request\n` +
        `  couldn't be sent. Set a full URL (with http:// and the /v1 suffix) in\n` +
        `  /admin/settings → Embedding, e.g. http://host.docker.internal:8090/v1.\n` +
        `  (${raw})`
      );
    case 'unknown':
    default:
      return `Embedding probe failed: ${raw}`;
  }
}

// Best-effort pull of a missing Ollama model; any error is swallowed and
// reported via the next probe.
async function tryOllamaPull(model: string, ollamaUrl: string): Promise<boolean> {
  if (!model || !ollamaUrl) return false;
  console.log(`[tag] auto-pulling Ollama embedding model "${model}" from ${ollamaUrl}...`);
  try {
    const res = await fetch(`${ollamaUrl.replace(/\/+$/, '')}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: model, stream: true }),
    });
    if (!res.ok || !res.body) {
      console.error(`[tag] pull failed: HTTP ${res.status}`);
      return false;
    }
    // Drain the NDJSON progress stream so the pull actually completes.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let lastStatus = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.error) {
            console.error(`[tag] pull error: ${evt.error}`);
            return false;
          }
          if (evt.status && evt.status !== lastStatus && !evt.status.startsWith('pulling ')) {
            console.log(`[tag] pull: ${evt.status}`);
            lastStatus = evt.status;
          }
        } catch { /* tolerate partial lines / non-JSON */ }
      }
    }
    console.log(`[tag] pull complete: ${model}`);
    return true;
  } catch (err: any) {
    console.error(`[tag] pull failed: ${err?.message || err}`);
    return false;
  }
}

// Probe an explicit embedding config: one-off model, embed a short string,
// return the real vector length or an actionable message. Shared by probeOnce()
// and /settings/embedding/probe (unsaved form values), so both classify alike.
export async function probeEmbeddingConfig(
  overrides: Partial<EmbeddingCfg> = {},
): Promise<ProbeResult> {
  const cfg = resolveEmbeddingCfg(overrides);
  const info = embeddingInfoOf(cfg);
  try {
    const model = buildEmbeddingModel(cfg);
    const { embeddings } = await embedMany({ model, values: ['subwave embedding probe'] });
    // Real vector length from the live server, not the name→dim guess (#319).
    const dim = Array.isArray(embeddings?.[0]) ? embeddings[0].length : undefined;
    return { code: 'ok', message: 'ok', dim, provider: info.provider };
  } catch (err: any) {
    const { code, raw } = classifyEmbeddingError(err);
    return { code, message: actionableMessage(code, raw, info), provider: info.provider };
  }
}

function probeOnce(): Promise<ProbeResult> {
  return probeEmbeddingConfig();
}

// Readiness check used by the tagger before phase-1. Auto-pulls a missing
// Ollama model once and re-probes; otherwise returns the actionable message.
export async function ensureReady(): Promise<ProbeResult> {
  if (!embeddingEnabled()) {
    return { code: 'disabled', message: 'embeddings are disabled (settings.embedding.enabled=false)' };
  }
  const first = await probeOnce();
  if (first.code === 'ok') return first;
  if (first.code === 'not_found') {
    const { provider, model, ollamaUrl } = embeddingProviderInfo();
    if (provider === 'ollama' && (await tryOllamaPull(model, ollamaUrl))) {
      return probeOnce();
    }
  }
  return first;
}

// The tagging-provenance stamp: `prompt_hash` on every LLM-tagged row, and what
// `staleTaggedIds` compares against on --upgrade / admin Re-decide moods.
// Hashes the hand-bumped TAGGER_CONTRACT_VERSION plus the live mood vocabulary,
// deliberately NOT the prompt text (#1548) — a cosmetic reword must not re-tag
// the library, at the cost of a semantic edit that forgets the bump. `vocab` is
// injectable so scripts/tagger-contract-hash.test.ts can pin the inputs.
export function promptVocabHash(
  contractVersion: number,
  vocab: readonly string[] = moodVocab(),
): string {
  return crypto
    .createHash('sha256')
    .update(`tagger-contract-v${contractVersion}`)
    .update('|')
    .update(vocab.join(','))
    .digest('hex')
    .slice(0, 16);
}
