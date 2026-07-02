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
} from '../llm/provider.js';
import type { EmbeddingCfg } from '../llm/provider.js';
import { SHOW_MOODS as MOOD_VOCAB } from '../settings.js';
import crypto from 'node:crypto';

const LYRIC_EXCERPT_CHARS = 400; // cap lyrics before they bloat the embedding text

export interface SongMeta {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  year?: number | string | null;
  genre?: string | null;
}

export interface TrackEnrichment {
  lastfmTags?: string[] | null;
  lyricExcerpt?: string | null;
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
export function formatTrackText(song: SongMeta, enrich?: TrackEnrichment | null): string {
  const head =
    `${song.artist || 'Unknown Artist'} — ${song.title || 'Unknown Title'} ` +
    `· ${song.album || 'Unknown Album'} (${song.year ?? '?'}) [${song.genre || '?'}]`;
  const lines = [head];
  if (enrich?.lastfmTags && enrich.lastfmTags.length) {
    lines.push(`Last.fm: ${enrich.lastfmTags.join(', ')}`);
  }
  if (enrich?.lyricExcerpt) {
    const trimmed = enrich.lyricExcerpt.slice(0, LYRIC_EXCERPT_CHARS).replace(/\s+/g, ' ').trim();
    if (trimmed) lines.push(`Lyrics: ${trimmed}`);
  }
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
// Preflight — classify the common configuration failures BEFORE running a
// 28,000-track embedding job so the operator gets an actionable message
// instead of a Node stack trace. Issue #174.
// ---------------------------------------------------------------------------

export type ProbeCode =
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

// The mood vocabulary is part of the LLM tagger's prompt; including its hash
// in promptHash means a vocab change auto-invalidates older tags via the
// --upgrade path.
export function promptVocabHash(systemPrompt: string): string {
  return crypto
    .createHash('sha256')
    .update(systemPrompt)
    .update('|')
    .update(MOOD_VOCAB.join(','))
    .digest('hex')
    .slice(0, 16);
}
