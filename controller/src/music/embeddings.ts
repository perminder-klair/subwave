// Text-embedding layer for the library tagger.
//
// Wraps the AI SDK embedMany call so the rest of the tagger can stay provider-
// agnostic. Provider + model are resolved via llm/provider.ts → tracks the
// existing settings.llm by default (Ollama local) or settings.embedding when
// the operator wants something different.
//
// The track-text formatter lives here too because it's the single canonical
// string-shape that drives every embedding. Seeds, propagation, future
// similarity queries — all use formatTrackText so the same input always
// produces the same vector.

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
  // The year the track's ERA is judged by — resolved by the CALLER via
  // show-filter.resolveEraYear (original year wins; a compilation's plain
  // year is untrusted), never raw `year`. Word-formed into an `Era: 1990s`
  // line: the head line's "(2013)" digits embed as near-arbitrary tokens,
  // while the decade as a WORD gives era-similarity something to grab — and
  // for reissues it's the true era, where the digits are the reissue's.
  eraYear?: number | null;
}

export interface TrackEnrichment {
  lastfmTags?: string[] | null;
  lyricExcerpt?: string | null;
}

// Measured acoustics from the analyzer pass (#1246). Deliberately NOT the
// tagger's own `moods` / `energy`: those are decided AFTER this text is
// embedded, by voting over the KNN graph built FROM these vectors
// (tag-library.ts phases 1→3), so feeding them back in is circular and on a
// fresh library they don't exist yet. Everything here comes off the waveform
// instead, before any of that.
export interface TrackAcoustics {
  bpm?: number | null;
  musicalKey?: string | null;      // Camelot code, e.g. '8A'
  // Zero-shot CLAP moods (music/audio-moods.ts) — the mood vocabulary scored
  // against the track's audio vector, so these are how it SOUNDS, never what
  // its title suggests. Heavy-tier only; absent on a lean analyzer.
  audioMoods?: string[] | null;
  // Vocal-presence ranges (tracks.vocal_ranges). [] = measured instrumental,
  // non-empty = has vocals, null/undefined = not computed. Only the MINORITY
  // marker is written ('instrumental'); vocal tracks get no word, because a
  // word carried by ~80% of a library clusters nothing.
  vocalRanges?: unknown[] | null;
  // The pace curve is deliberately NOT an input. An energy word was tried and
  // backed out: the curve's practical range is ~0.02–0.5 (measured mean 0.09
  // across a fully-analysed library), so any fixed threshold stamps one word
  // on ~everything ("calm" on 99.5% of tracks, contradicting CLAP's
  // "energetic" in the same line), and library-relative thresholds would make
  // the text non-deterministic. CLAP's mood vocabulary already carries energy
  // words measured from sound; the raw mean stays LLM-facing (picker payload).
}

// Bump when the shape of formatTrackText's output changes in a way that moves
// vectors. Recorded in embedding_meta.text_format so an index built under an
// older shape is detectable (library-coverage.embeddingFormatStale) instead of
// silently mixing two text shapes in one KNN space. Legacy rows read as 1.
//
//   1  head line + Last.fm tags + lyric excerpt
//   2  ... + the Sound: descriptor line (audio moods, tempo band, key mode,
//      instrumental marker) + the Era: decade line (#1246)
export const EMBED_TEXT_VERSION = 2;

// Tempo as a word, not a number: an embedding model reads "uptempo" as a
// musical property and "128" as an arbitrary token, so the band is the part
// that carries meaning. Ranges follow the ordinary DJ vocabulary rather than
// anything clever — the goal is a coarse axis that isn't the artist's name.
function tempoWord(bpm: number): string | null {
  if (!Number.isFinite(bpm) || bpm <= 0) return null;   // 0 = unknown, never "very slow"
  if (bpm < 80) return 'slow tempo';
  if (bpm < 105) return 'mid-tempo';
  if (bpm < 130) return 'upbeat tempo';
  return 'fast tempo';
}

// The analyzer stores a Camelot code ('8A'), which embeds as a meaningless
// token. The musically-legible half of it is the mode: 'A' = minor, 'B' =
// major. The number is the tonic (which key), and two tracks sharing a tonic
// are no more alike in mood than two sharing a BPM digit — so it stays out.
// The wheel only has positions 1–12; anything else ('0A', '13B') isn't a
// Camelot code and contributes nothing rather than a fabricated mode.
function keyModeWord(camelot: string): string | null {
  const m = /^\s*(?:[1-9]|1[0-2])\s*([AB])\s*$/i.exec(camelot);
  if (!m) return null;
  return m[1].toUpperCase() === 'A' ? 'minor key' : 'major key';
}

// The descriptor words for a track's measured sound, in a stable order (the
// same input must always produce the same vector). Empty when nothing has been
// analysed — the caller then omits the line entirely rather than embedding a
// bare "Sound:" label, which would be pure noise repeated across every
// un-analysed track and would cluster THEM together.
export function soundDescriptors(acoustics?: TrackAcoustics | null): string[] {
  if (!acoustics) return [];
  const words: string[] = [];
  // Audio moods first — real vocabulary words, the strongest musical signal
  // available here, and the one thing in this line that distinguishes two
  // tracks at the same tempo in the same mode.
  for (const m of acoustics.audioMoods ?? []) {
    const t = String(m || '').trim();
    if (t) words.push(t);
  }
  const tempo = acoustics.bpm != null ? tempoWord(Number(acoustics.bpm)) : null;
  if (tempo) words.push(tempo);
  const mode = acoustics.musicalKey ? keyModeWord(acoustics.musicalKey) : null;
  if (mode) words.push(mode);
  // [] is a MEASUREMENT ("no vocals found"), null is its absence — only the
  // measured-instrumental case speaks (see the interface note).
  if (Array.isArray(acoustics.vocalRanges) && acoustics.vocalRanges.length === 0) {
    words.push('instrumental');
  }
  return words;
}

// The Era line's decade word ('1990s'). Input is the RESOLVED era year
// (show-filter.resolveEraYear) — callers must never pass raw `year`, which on
// a compilation is the compilation's own release date. Sub-millennium years
// are junk tags (TDRC=0007 and friends), not ancient recordings.
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
  // The embedding work runs on the operator's own hardware (CPU/NAS-bound), so a
  // heavy model directly slows re-embeds. Cloud providers do the work off-box.
  local: boolean;
  // Large + slow on CPU relative to the light default (nomic-embed-text).
  heavy: boolean;
}

// Performance profile of the active embedding model — drives the doctor's
// "embedding model" advisory. A heavy LOCAL model (bge-m3, *-large) is the quiet
// cause of slow re-embeds + Ollama RAM thrash on a CPU/NAS box; cloud models are
// never a perf concern (the work runs off-box), so `local` gates the warning.
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

// Used by library.ts on first open — we need the schema dim before any
// embedding call.
export function resolveEmbeddingDim(): number {
  return activeEmbeddingDim();
}

// Canonical text shape. Single function so seed + propagation + future
// similarity queries all produce the same vector for the same input.
//
// Without enrichment:
//   "Snoop Dogg — Slid Off · Missionary (2024) [Hip-Hop]"
//
// With enrichment (the v1 default when both signals exist):
//   "Snoop Dogg — Slid Off · Missionary (2024) [Hip-Hop]
//    Last.fm: chill, west-coast, smooth, late-night
//    Lyrics: I slid off, ain't been the same since the call dropped..."
//
// With measured acoustics (v2, #1246 — present as soon as the analyzer has run,
// which needs no API key and no LLM call), plus the resolved era as a decade
// word:
//   "... Sound: smooth, late-night, mid-tempo, minor key
//        Era: 2020s"
//
// Every optional line is omitted when its signal is absent, never emitted
// empty: a constant "Sound:" label on un-analysed tracks would be noise shared
// by all of them, which clusters exactly the tracks it says nothing about.
export function formatTrackText(
  song: SongMeta,
  enrich?: TrackEnrichment | null,
  acoustics?: TrackAcoustics | null,
): string {
  // All genre tags, comma-joined — multi-genre tracks embed with their full
  // tag set so genre-adjacent similarity reflects every tag, not just genres[0].
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
  // Measured sound (#1246). Without this — and with Last.fm tags off by default
  // for keyless installs, and lyrics matching only a small share of a library —
  // the vector for most tracks IS the head line, so cosine similarity over it
  // ranks by artist/album TEXT while presenting itself to the picker as mood
  // similarity: every track by one artist shares an artist string and so
  // self-clusters, and "Nick Drake" sits next to "Drake". This line is the
  // cheapest musical signal that exists before the tagger has decided anything.
  const sound = soundDescriptors(acoustics);
  if (sound.length) lines.push(`Sound: ${sound.join(', ')}`);
  // Era as a word (#1246). Label-derived, not measured — which is why it gets
  // its own line instead of riding Sound:, and why labelOnlyVectorCount
  // deliberately does NOT treat it as musical signal.
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

// ---------------------------------------------------------------------------
// Task-prefix handling — some embedding models (nomic-embed-text, the shipped
// default) are trained with mandatory task prefixes: `search_document:` on
// indexed texts and `search_query:` on queries. Document prefixes change the
// stored vectors, so the index records its mode in embedding_meta.text_mode
// ('plain' = embedded bare, 'prefixed' = embedded with the document prefix)
// and every query embed must match it. See embeddingTextPrefixes in
// llm/internal/provider/embedding.ts for the per-model table.
// ---------------------------------------------------------------------------

export type IndexTextMode = 'plain' | 'prefixed';

function activePrefixes(): EmbeddingTextPrefixes {
  return embeddingTextPrefixes(embeddingProviderInfo().model);
}

// The mode a FRESH index should be built in for the active model: 'prefixed'
// when the model has a document prefix, else 'plain'.
export function preferredTextMode(): IndexTextMode {
  return activePrefixes().document ? 'prefixed' : 'plain';
}

// Resolve the mode of an EXISTING index. Stored mode always wins (consistency
// beats preference — a prefixed query against bare documents is worse than
// bare-vs-bare). A populated index with no recorded mode predates mode
// tracking and was embedded bare; an empty one is free to adopt the model's
// preferred mode.
export function resolveIndexTextMode(
  stored: IndexTextMode | null | undefined,
  vectorCount: number,
): IndexTextMode {
  if (stored) return stored;
  if (vectorCount > 0) return 'plain';
  return preferredTextMode();
}

// What text format the index should be RECORDED as, given what's already in it
// (#1246). The meta row describes the vectors that EXIST, not the recipe this
// build happens to use — same shape as resolveIndexTextMode above.
//
// A forward run embeds only vectorless tracks, so the index becomes a MIX. The
// stored (older) format therefore wins: recording the current one would erase
// the only signal that a re-embed is worth running. An empty index has nothing
// to be inconsistent with and adopts the current format, which is why a fresh
// install never sees the advisory.
//
// A stored format NEWER than this build (a downgraded controller) clamps down
// for the same reason — this run embeds at ITS shape, so the oldest shape now
// present is its own, and the newer controller sees the mix once restored.
//
// `reseed` is the one case that rewrites every vector, so it always adopts.
export function resolveIndexTextFormat(
  stored: number | null | undefined,
  vectorCount: number,
  reseed = false,
): number {
  if (reseed) return EMBED_TEXT_VERSION;
  if (vectorCount > 0) return Math.min(stored ?? 1, EMBED_TEXT_VERSION);
  return EMBED_TEXT_VERSION;
}

// Pure prefix application, exported for tests. `prefixes` defaults to the
// active model's table entry.
export function applyDocPrefix(
  text: string,
  mode: IndexTextMode,
  prefixes: EmbeddingTextPrefixes = activePrefixes(),
): string {
  return mode === 'prefixed' && prefixes.document ? prefixes.document + text : text;
}

// A query prefix applies when the index carries document prefixes too
// ('prefixed'), OR when the model prefixes queries only (mxbai-style — the
// documents embed bare by design, so the index mode doesn't gate it).
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

// ---------------------------------------------------------------------------
// Preflight — classify the common configuration failures BEFORE running a
// 28,000-track embedding job so the operator gets an actionable message
// instead of a Node stack trace. Issue #174.
// ---------------------------------------------------------------------------

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
  // Vector length measured from a successful probe. Authoritative dim for the
  // schema — beats guessing from the model name (#319). Only set when code==ok.
  dim?: number;
  // Resolved embedding provider ("follow LLM" already resolved). Lets callers
  // tailor messaging — e.g. the Test endpoint's Ollama auto-pull note — without
  // re-deriving the provider.
  provider?: string;
}

function classifyEmbeddingError(err: any): { code: ProbeCode; raw: string } {
  const raw = err?.message || String(err);
  const status = err?.cause?.status_code ?? err?.statusCode ?? err?.status;
  const txt = raw.toLowerCase();
  // buildEmbeddingModel throws this for chat-only providers (deepseek / gateway)
  // that have no embeddings endpoint at all (#493). Check before the
  // network-shaped codes — it's a config error, not a reachability one.
  if (txt.includes('has no text-embedding support')) {
    return { code: 'no_embeddings', raw };
  }
  if (status === 404 || txt.includes('not found') || txt.includes('try pulling')) {
    return { code: 'not_found', raw };
  }
  if (status === 401 || status === 403 || txt.includes('unauthorized') || txt.includes('forbidden')) {
    return { code: 'unauthorized', raw };
  }
  // Server is up and authenticated, but the loaded model can't embed: either it
  // was started without the embeddings endpoint, or it's a generative/chat model
  // whose pooling type is 'none' (not OAI-compatible). The classic trap when an
  // openai-compatible embedding config inherits the *chat* server's baseUrl (#319).
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
  // A missing or malformed base URL makes the SDK build a relative request URL
  // (e.g. just "/embeddings"), which fetch rejects before any network call.
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

// Attempt to pull a missing Ollama model. Returns true on success. Best-effort:
// any error from the pull is swallowed and reported via the next probe.
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
    // Drain the NDJSON progress stream so the pull actually completes; only
    // print milestone status lines to keep the log readable.
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

// Probe an explicit embedding config — builds a one-off model, embeds a short
// string, and returns the real vector length on success or an actionable
// message on failure. Shared by probeOnce() (saved config, used by the tagger
// preflight) and the /settings/embedding/probe endpoint (unsaved form values,
// passed as overrides) so both classify identically and name the right server.
export async function probeEmbeddingConfig(
  overrides: Partial<EmbeddingCfg> = {},
): Promise<ProbeResult> {
  const cfg = resolveEmbeddingCfg(overrides);
  const info = embeddingInfoOf(cfg);
  try {
    const model = buildEmbeddingModel(cfg);
    const { embeddings } = await embedMany({ model, values: ['subwave embedding probe'] });
    // Measure the real vector length from the live server — authoritative dim,
    // independent of the name→dim guess table (#319).
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

// One-shot readiness check used by the tagger before phase-1. Auto-pulls a
// missing Ollama model once and re-probes; on any other failure code, returns
// the friendly message so the caller can print + exit.
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

// The tagging-provenance stamp: `prompt_hash` on every LLM-tagged row, and the
// value `staleTaggedIds` compares against on --upgrade / admin Re-decide moods.
//
// It hashes TWO things and deliberately not a third:
//
//   - the tagger CONTRACT version (music/tagger-core.TAGGER_CONTRACT_VERSION),
//     bumped by hand when the prompt's meaning changes;
//   - the live mood vocabulary, so an operator editing settings.moods
//     auto-invalidates tags decided against the old list;
//   - NOT the prompt string itself (#1548). It used to take the rendered
//     `taggerBatchSystem()` text, which made every cosmetic reword — #1541's
//     transport-wording fix, a typo, a reflowed line — re-tag the entire
//     library on the next Re-decide: ~1600 batch calls on a 40k library
//     against a homelab Ollama box, for a contract that did not change.
//
// The trade is stated in docs/internals/music.md: the version has to be bumped
// by hand, so a semantic prompt edit that forgets it never re-decides.
//
// `vocab` is injectable so scripts/tagger-contract-hash.test.ts can pin the
// inputs without loading settings (same shape as audio-moods.moodVocabHash).
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
