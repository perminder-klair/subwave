// The settings GET/POST plus the two credential writes (cloud secrets,
// Navidrome) that land outside settings.json.

import express from 'express';
import { navidromeEnvLocks } from '../../setup/navidrome-policy.js';
import { config, NAVIDROME_ENV_ENABLED } from '../../config.js';
import * as subsonic from '../../music/subsonic.js';
import { clearPoolCache } from '../../music/picker.js';
import { clearNavidromeCache } from '../../doctor.js';
import { refreshAutoPlaylist } from '../../broadcast/scheduler.js';
import { applyNavidromeToLiveConfig, saveSetupConfig } from '../../setup/config.js';
import { invalidatePool, poolConfigured, poolSize, poolStatus } from '../../util/google-key-pool.js';
import * as library from '../../music/library.js';
import * as jingles from '../../broadcast/jingles.js';
import * as settings from '../../settings.js';
import { BOUNDARY_MIN_PLAY_SEC, BOUNDARY_TOLERANCE_SEC } from '../../broadcast/show-boundary.js';
import * as tts from '../../audio/tts.js';
import * as remoteTts from '../../audio/remoteTts.js';
import * as chatterbox from '../../audio/chatterbox.js';
import * as piper from '../../audio/piper.js';
import * as llmProvider from '../../llm/provider.js';
import { queue } from '../../broadcast/queue.js';
import { handoverOffsetMinutes } from '../../broadcast/handover-policy.js';
import { streamStatus } from '../../broadcast/liquidsoap-control.js';
import { requireAdmin } from '../../middleware/auth.js';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText } from 'ai';
import { briefLlmError } from './llm.js';
import {
  bumpPoolRevision,
  entryId,
  GOOGLE_KEY_MAX,
  GOOGLE_KEYS_ENV,
  GOOGLE_KEY_ENV,
  GOOGLE_POOL_MAX,
  poolEntries,
  poolKeys,
  poolRevision,
  sanitizeName,
  serializePool,
  withPoolLock,
} from '../../util/google-key-pool.js';
import { validateSettingsBody } from '../../middleware/validate.js';
import { saveSecretsWithinLock, SECRET_ENV_KEYS } from '../../setup/secrets.js';
import { taggerView } from '../../broadcast/tagger.js';
import { currentMode as budgetCurrentMode } from '../../broadcast/dj-budget.js';
import { skillCatalog } from '../../skills/_agent.js';

// Mounted onto the parent settings router in ../settings.ts.
export const router = express.Router();

// Everything the /settings UI needs, in one response.
router.get('/settings', requireAdmin, async (req, res) => {
  try {
    await library.load();
    await settings.load();
    // Redacted: secrets come back as "set"/"" and round-trip harmlessly.
    const s = settings.getRedacted();
    // A telnet failure must not 500 the whole settings load.
    let streamOnAir: boolean | null = null;
    try { streamOnAir = await streamStatus(); } catch {}
    // On air is resolved through getEffectivePersona (a live show's owner, else
    // the default), never activePersonaId, so a show override surfaces.
    const onAirPersona = settings.getEffectivePersona();
    const activeShow = settings.resolveActiveShow();
    const onAir = {
      personaId: onAirPersona?.id || '',
      // null means the default persona is on air.
      show: activeShow?.persona?.id ? { id: activeShow.id, name: activeShow.name } : null,
    };
    // Reference-WAV voices are shared by chatterbox + pocket-tts (#213).
    const customVoices = await chatterbox.listReferenceVoices();
    // Custom Piper voices in the same folder (#230), .onnx + .onnx.json pairs.
    const piperVoices = await piper.listPiperVoices();
    const voiceDir = chatterbox.voiceDir();
    res.json({
      autoPick: queue.autoPick,
      pickerBusy: queue.pickerBusy,
      streamOnAir,
      onAir,
      jingles: await jingles.list(),
      libraryStats: library.stats(),
      tagger: taggerView(),
      // Daily-token-budget tier (normal|soft|hard); 'normal' when the cap is off.
      budget: { mode: budgetCurrentMode() },
      ollama: { url: config.ollama.url, model: config.ollama.model },
      // Password never leaves the process (passSet only). Env flags are
      // per-field because server.ts applies setup-config per-field.
      navidrome: {
        url: config.navidrome.url,
        user: config.navidrome.user,
        passSet: !!config.navidrome.password,
        env: navidromeEnvLocks(NAVIDROME_ENV_ENABLED),
      },
      // What timezone '' (Auto) resolves to, for the UI's Auto label.
      serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      values: {
        jingleRatio: s.jingleRatio,
        // Who counts the tracks between jingles (#1619) — the admin control that
        // hands the rotate to the controller and writes the mixer's ratio 0.
        jingleRotate: s.jingleRotate,
        crossfadeDuration: s.crossfadeDuration,
        ducking: s.ducking,
        // Repaired on the way out via the same function the air path uses: a
        // profile switch or backup restore can seed an off-step value (#1576).
        handover: { offsetMinutes: handoverOffsetMinutes() },
        djBehaviour: s.djBehaviour,
        maxTrackSeconds: s.maxTrackSeconds,
        maxTrackLengthMode: s.maxTrackLengthMode,
        // Crossfade-relative floor, shared with the admin/show UI so client
        // hints match server validation.
        minTrackSeconds: settings.minTrackSeconds(s),
        archive: s.archive,
        // Edited from the Backup panel, but saved through POST /settings.
        backups: s.backups,
        stream: s.stream,
        loudness: s.loudness,
        silenceTrim: s.silenceTrim,
        fadeAtShowEnd: s.fadeAtShowEnd,
        // Shortest playable track a boundary cut can arm on; a maxTrackSeconds
        // cap at or below this disables the feature. Served, never restated in
        // the UI, so the hint uses the number the drain uses.
        boundaryFadeMinTrackSeconds: BOUNDARY_MIN_PLAY_SEC + BOUNDARY_TOLERANCE_SEC,
        station: s.station,
        stationDescription: s.stationDescription,
        timezone: s.timezone,
        locale: s.locale,
        theme: s.theme,
        festivals: s.festivals,
        moods: s.moods,
        moodSchedule: s.moodSchedule,
        weatherMoods: s.weatherMoods,
        weather: s.weather,
        djPrompt: s.djPrompt,
        djPrompts: s.djPrompts,
        activeDjPromptId: s.activeDjPromptId,
        djHouseRules: s.djHouseRules,
        personas: s.personas,
        activePersonaId: s.activePersonaId,
        shows: s.shows,
        schedule: s.schedule,
        djTalkOnlyBetweenTracks: s.djTalkOnlyBetweenTracks,
        pauseTalkMinSeconds: s.pauseTalkMinSeconds,
        tts: s.tts,
        llm: s.llm,
        search: s.search,
        embedding: s.embedding,
        likes: s.likes,
        // The admin form hydrates the album-cooldown/min-length inputs from
        // this; omit it and the next save on that card zeroes them.
        picker: s.picker,
        audio: s.audio,
        transitions: s.transitions,
        sfx: s.sfx,
        beds: s.beds,
        ui: s.ui,
        scrobble: s.scrobble,
        // privacy.password arrives redacted ('set'/'').
        privacy: s.privacy,
        requests: s.requests,
      },
      defaults: {
        // Shown by the UI when djPrompt is "".
        djPrompt: settings.DEFAULT_DJ_PROMPT_TEMPLATE,
        personas: settings.getDefaults().personas,
        tts: settings.getDefaults().tts,
        llm: settings.getDefaults().llm,
        search: settings.getDefaults().search,
        locale: settings.getDefaults().locale,
      },
      tts: {
        engines: tts.ENGINES,
        available: tts.availableEngines(),
        kokoroVoices: settings.KOKORO_VOICES,
        kokoroVoiceLanguages: settings.KOKORO_VOICE_LANGUAGES,
        kokoroLangs: settings.KOKORO_LANGS,
        voiceDir,
        piperVoices,
        chatterboxVoices: customVoices,
        // Alias of voiceDir, kept for older UI builds.
        chatterboxVoiceDir: voiceDir,
        pocketTtsVoices: settings.POCKET_TTS_VOICES,
        pocketTtsCustomVoices: customVoices,
        cloudProviders: settings.TTS_CLOUD_PROVIDERS,
        frequencies: settings.FREQUENCIES,
        // Live mood names from the operator-editable vocabulary.
        moods: settings.moodVocab(),
      },
      llm: {
        providers: settings.LLM_PROVIDERS,
        active: llmProvider.activeModelLabel(),
      },
      embedding: {
        // Embedding-capable providers only, a strict subset of llm.providers,
        // so a chat-only provider can't be chosen here (#493).
        providers: settings.EMBEDDING_PROVIDERS,
      },
      search: {
        providers: settings.SEARCH_PROVIDERS,
      },
      // Which provider API keys are present in the environment; the UI keys
      // its "key missing" alerts off this.
      env: {
        OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
        ELEVENLABS_API_KEY: !!process.env.ELEVENLABS_API_KEY,
        FISH_API_KEY: !!process.env.FISH_API_KEY,
        ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
        // True when EITHER variable holds a Google credential. Reporting only the
        // literal singular var made a pool-only station claim no key was on file,
        // which disabled the admin field's Test button against a working key.
        GOOGLE_GENERATIVE_AI_API_KEY: !!process.env.GOOGLE_GENERATIVE_AI_API_KEY || poolConfigured(),
        // Google key POOL state. Fingerprints and hold timers only — no key
        // material ever crosses this boundary. `count` drives the UI's
        // single-key vs pooled-key rendering.
        GOOGLE_KEY_POOL: {
          count: poolSize(),
          // Bumped by every mutation so the UI can tell "someone else changed
          // the pool" from "my change landed" — the difference between a stale
          // row and a fresh one, and the reason a click can be refused instead
          // of hitting the wrong credential.
          revision: poolRevision(),
          keys: poolStatus(),
        },
        DEEPSEEK_API_KEY: !!process.env.DEEPSEEK_API_KEY,
        OPENROUTER_API_KEY: !!process.env.OPENROUTER_API_KEY,
        REQUESTY_API_KEY: !!process.env.REQUESTY_API_KEY,
        AI_GATEWAY_API_KEY: !!process.env.AI_GATEWAY_API_KEY,
        SEARCH_API_KEY: !!process.env.SEARCH_API_KEY,
        EMBEDDING_API_KEY: !!process.env.EMBEDDING_API_KEY,
        LASTFM_API_KEY: !!process.env.LASTFM_API_KEY,
        LASTFM_API_SECRET: !!process.env.LASTFM_API_SECRET,
        LASTFM_SESSION_KEY: !!process.env.LASTFM_SESSION_KEY,
        LISTENBRAINZ_USER_TOKEN: !!process.env.LISTENBRAINZ_USER_TOKEN,
        LISTENBRAINZ_API_URL: !!process.env.LISTENBRAINZ_API_URL,
      },
      skills: { catalog: skillCatalog() },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update values; returns { requiresRestart } for mixer-affecting keys.
// validateSettingsBody() rejects unknown top-level keys HERE and not in
// settings.update(): backup restore hands update() a whole settings.json, and
// a key from a newer version must cost one setting, not the whole restore.
router.post('/settings', requireAdmin, validateSettingsBody(), async (req, res) => {
  try {
    const result = await settings.update(req.body || {});
    // context.ts reads the live settings cache, so the update already applies;
    // the route only owns the operator-facing log.
    if ('weather' in (req.body || {})) {
      queue.log(
        'scheduler',
        `weather location → ${result.saved.weather.locationName} (${result.saved.weather.units}) · on air → ${settings.resolveOnAirLocation(result.saved)}`,
      );
    }
    if (result.requiresRestart) {
      queue.log('scheduler', `mixer settings changed — Liquidsoap restart required`);
    }
    // Re-probe now so the admin badge doesn't wait out the 30s probe tick.
    if (req.body?.tts?.remote?.url !== undefined) {
      await remoteTts.refresh();
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Writes API keys to state/secrets.env. Only SECRET_ENV_KEYS are accepted and
// a blank value means "keep the existing key". Applies in-process immediately.
router.post('/settings/secrets', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Body must be a key-value object' });
    }
    const patch: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (!(SECRET_ENV_KEYS as readonly string[]).includes(key)) continue;
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (!trimmed) continue;
      if (trimmed.length > 4096) continue;
      patch[key] = trimmed;
    }
    if (Object.keys(patch).length === 0) {
      return res.json({ saved: [] });
    }
    // A patch naming either Google variable is a POOL MUTATION, and this route
    // takes the same lock as the pool endpoints for EVERY patch — not only a
    // pool one. `saveSecrets` rewrites the whole file, so an unrelated key save
    // and a pool mutation are the same read-modify-write of the same bytes; a
    // lock that only the pool-touching half took left exactly the losing case
    // unprotected (two unrelated keys saved concurrently lost one, 20 runs in 20,
    // both answering 200).
    //
    // The whole body is inside the lock, INCLUDING the memo drop. Dropping it
    // after the write released would let the next writer read the pre-write pool
    // from the cache and write that stale list back — the same lost update one
    // step later.
    const touchesPool = GOOGLE_KEYS_ENV in patch || GOOGLE_KEY_ENV in patch;
    const write = async () => {
      // saveSecretsWithinLock, because the lock is already held here.
      await saveSecretsWithinLock(patch);
      // saveSecrets writes process.env, but the Google pool memoizes its parsed
      // key list for a couple of seconds. Drop that memo here so the field's
      // "takes effect immediately" is true rather than nearly true — this is the
      // single writer for secrets, so this is the only place it can go stale.
      if (touchesPool) {
        invalidatePool();
        bumpPoolRevision();
      }
      return Object.keys(patch);
    };
    res.json({ saved: await withPoolLock(write) });
  } catch (err: unknown) {
    console.error('[settings/secrets]', err);
    res.status(400).json({ error: 'Failed to save secrets' });
  }
});

// ── Google key pool maintenance ────────────────────────────────────────────
//
// Keys are addressed by an OPAQUE ID (`entryId`, a hash of the key), never by
// index and never by value. The client is never sent key material, so it
// cannot name a credential by value either — which is the point: an id cannot
// be reconstructed into a key, and it survives a reorder or a rename.
//
// Indexes looked equivalent and were not. A range check passes when the index
// is stale but still in bounds, so "remove index 0" issued after another client
// reordered the pool destroyed a DIFFERENT credential and answered HTTP 200.
// The id makes that request either hit the intended key or find nothing.
//
// Every mutation runs inside `withPoolLock` and returns the pool REVISION it
// produced. The lock stops two concurrent handlers from each writing a list
// derived from the same read (four concurrent adds previously returned
// `count: 2` four times while persisting one credential); the revision lets a
// client detect that someone else changed the pool between its render and its
// click, which the lock cannot prevent because the other change may be
// seconds old.
router.post('/settings/google-key-pool/remove', requireAdmin, async (req, res) => {
  const { id } = (req.body || {}) as { id?: unknown };
  if (typeof id !== 'string' || !id) {
    return res.status(400).json({ error: 'id is required' });
  }
  try {
    const out = await withPoolLock(async () => {
      const entries = poolEntries();
      const at = entries.findIndex(e => entryId(e.key) === id);
      // A stale id is a 409, not a silent success: the key the operator clicked
      // is gone, and reporting "removed" would hide a credential that is
      // still configured and still being used.
      if (at === -1) return { conflict: true as const };
      const next = entries.filter((_, i) => i !== at);
      // An emptied pool clears BOTH vars: leaving the legacy single-key var set
      // would silently resurrect the key the operator just removed.
      if (next.length) {
        await saveSecretsWithinLock({ [GOOGLE_KEYS_ENV]: serializePool(next) });
      } else {
        await saveSecretsWithinLock({ [GOOGLE_KEYS_ENV]: '', [GOOGLE_KEY_ENV]: '' });
        delete process.env[GOOGLE_KEYS_ENV];
        delete process.env[GOOGLE_KEY_ENV];
      }
      invalidatePool();
      bumpPoolRevision();
      return { count: next.length };
    });
    if ('conflict' in out) {
      return res.status(409).json({ error: 'that key is no longer in the pool', revision: poolRevision() });
    }
    res.json({ ok: true, count: out.count, revision: poolRevision() });
  } catch (err) {
    console.error('[settings/google-key-pool/remove]', err);
    res.status(500).json({ error: 'Failed to update the key pool' });
  }
});

// Add a key. Its OWN endpoint because the generic `/settings/secrets` writer
// REPLACES the value it is given, and the client cannot construct the new
// list — it is never sent the key values, by design. Sending only the new key
// through that route therefore replaced the whole pool on every add, leaving
// the operator with whichever key they typed last.
//
// A duplicate is refused rather than added, since parsePool dedupes on read and
// the UI would otherwise show a phantom slot.
router.post('/settings/google-key-pool/add', requireAdmin, async (req, res) => {
  const { key, name } = (req.body || {}) as { key?: unknown; name?: unknown };
  const trimmed = String(key ?? '').trim();
  if (!trimmed) return res.status(400).json({ error: 'key is required' });
  if (trimmed.length > GOOGLE_KEY_MAX) {
    return res.status(400).json({ error: `key must be at most ${GOOGLE_KEY_MAX} characters` });
  }
  if (name != null && typeof name !== 'string') {
    return res.status(400).json({ error: 'name must be a string' });
  }
  try {
    const out = await withPoolLock(async () => {
      const entries = poolEntries().map(e => ({ ...e }));
      if (entries.some(e => e.key === trimmed)) {
        return { duplicate: true as const };
      }
      if (entries.length >= GOOGLE_POOL_MAX) {
        return { full: true as const };
      }
      entries.push({ key: trimmed, name: sanitizeName(name ?? '') });
      await saveSecretsWithinLock({ [GOOGLE_KEYS_ENV]: serializePool(entries) });
      invalidatePool();
      bumpPoolRevision();
      return { count: entries.length };
    });
    if ('duplicate' in out) {
      return res.status(409).json({ error: 'that key is already in the pool', revision: poolRevision() });
    }
    if ('full' in out) {
      return res.status(400).json({ error: `the pool is capped at ${GOOGLE_POOL_MAX} keys` });
    }
    res.json({ ok: true, count: out.count, revision: poolRevision() });
  } catch (err) {
    console.error('[settings/google-key-pool/add]', err);
    res.status(500).json({ error: 'Failed to add the key' });
  }
});

// Reorder the pool. The ORDER is the feature — free keys belong first so the
// paid key at the end absorbs only what the free tiers can't — so reordering
// has to exist rather than being fixed at insertion time.
//
// `id`/`beforeId` rather than from/to indices for the same reason as remove:
// an index pair is a pair of stale references the moment anything moves, and a
// move is exactly when an operator has two tabs open.
router.post('/settings/google-key-pool/move', requireAdmin, async (req, res) => {
  const { id, to } = (req.body || {}) as { id?: unknown; to?: unknown };
  if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'id is required' });
  if (!Number.isInteger(to) || (to as number) < 0) {
    return res.status(400).json({ error: 'to must be a non-negative integer' });
  }
  try {
    const out = await withPoolLock(async () => {
      const entries = poolEntries();
      const from = entries.findIndex(e => entryId(e.key) === id);
      if (from === -1) return { conflict: true as const };
      const clamped = Math.min(to as number, entries.length - 1);
      const next = [...entries];
      const [moved] = next.splice(from, 1);
      next.splice(clamped, 0, moved);
      if (next.every((e, i) => e.key === entries[i].key)) {
        return { count: entries.length };
      }
      // Serialised from ENTRIES, not keys — a reorder that rewrote the pool from
      // bare keys would strip every label the operator just typed.
      await saveSecretsWithinLock({ [GOOGLE_KEYS_ENV]: serializePool(next) });
      invalidatePool();
      bumpPoolRevision();
      return { count: next.length };
    });
    if ('conflict' in out) {
      return res.status(409).json({ error: 'that key is no longer in the pool', revision: poolRevision() });
    }
    res.json({ ok: true, count: out.count, revision: poolRevision() });
  } catch (err) {
    console.error('[settings/google-key-pool/move]', err);
    res.status(500).json({ error: 'Failed to reorder the key pool' });
  }
});

// Label one key. The name lives inline in the same variable as the key
// (`key:name`) rather than in a parallel array indexed by position, which is
// the shape that silently reattaches labels to the wrong credentials the first
// time a key is removed or moved.
router.post('/settings/google-key-pool/rename', requireAdmin, async (req, res) => {
  const { id, name } = (req.body || {}) as { id?: unknown; name?: unknown };
  if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'id is required' });
  if (name != null && typeof name !== 'string') {
    return res.status(400).json({ error: 'name must be a string' });
  }
  try {
    const out = await withPoolLock(async () => {
      const entries = poolEntries().map(e => ({ ...e }));
      const at = entries.findIndex(e => entryId(e.key) === id);
      if (at === -1) return { conflict: true as const };
      const clean = sanitizeName(name ?? '');
      entries[at].name = clean;
      await saveSecretsWithinLock({ [GOOGLE_KEYS_ENV]: serializePool(entries) });
      invalidatePool();
      bumpPoolRevision();
      // The STORED name, not the submitted one: sanitising can change what the
      // operator typed (a comma is a separator, so it becomes a space), and
      // echoing back their raw input would leave the UI showing something the
      // pool does not contain.
      return { name: clean };
    });
    if ('conflict' in out) {
      return res.status(409).json({ error: 'that key is no longer in the pool', revision: poolRevision() });
    }
    res.json({ ok: true, name: out.name, revision: poolRevision() });
  } catch (err) {
    console.error('[settings/google-key-pool/rename]', err);
    res.status(500).json({ error: 'Failed to rename the key' });
  }
});

// A model this key can actually SERVE. Availability is per-key AND per-project,
// and the listing is not trustworthy on its own: Google still advertises
// `gemini-2.5-flash` as generateContent-capable on keys where calling it 404s
// with "no longer available". Picking from the list therefore reports a
// perfectly good key as broken — worse than no test, because the operator's
// conclusion would be false. So we build a short ordered preference from what the
// key advertises, newest first, and actually CALL them until one answers.
const GOOGLE_FLASH_FALLBACK = 'gemini-3.5-flash-lite';

async function probeCandidates(key: string, configured?: string | null): Promise<string[]> {
  const wanted = configured?.trim();
  const out: string[] = [];
  if (wanted) out.push(wanted);
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) {
      const data = (await r.json()) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] };
      const ids = (data.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => String(m.name || '').replace(/^models\//, ''))
        .filter(Boolean);
      // Newest first — the listing comes back oldest-first, and the retired
      // models are the old ones.
      const flash = ids
        .filter(id => /flash/.test(id) && !/preview|tts|native-audio|image/.test(id))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      out.push(...flash);
    }
  } catch { /* fall through to the fallback */ }
  out.push(GOOGLE_FLASH_FALLBACK);
  return [...new Set(out)].slice(0, 4);
}

// Test ONE pooled key against the real API. Goes through the same provider
// path the station uses, but pins the key so a held key can be checked without
// disturbing the rotation state.
router.post('/settings/google-key-pool/test', requireAdmin, async (req, res) => {
  const { id } = (req.body || {}) as { id?: unknown };
  if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'id is required' });
  // By id, not index: an index is a position in a list the operator is looking
  // at, and testing whatever moved into that slot answers a question they did
  // not ask.
  const key = poolKeys().find(k => entryId(k) === id);
  if (!key) return res.status(409).json({ error: 'that key is no longer in the pool', revision: poolRevision() });
  try {
    const llm = settings.get().llm || {};
    const candidates = await probeCandidates(key, llm.provider === 'google' ? llm.model : undefined);
    let lastErr: unknown = new Error(`No servable model (tried: ${candidates.join(', ')})`);
    for (const model of candidates) {
      try {
        const m = createGoogleGenerativeAI({ apiKey: key })(model);
        await generateText({
          model: m,
          prompt: 'Reply with the single word OK.',
          maxOutputTokens: 32,
          abortSignal: AbortSignal.timeout(15_000),
        });
        res.json({ ok: true, message: `Key responded (${model})` });
        return;
      } catch (err) {
        lastErr = err;
        // 401/403/429 say something about the KEY, so trying another model
        // cannot help — stop and report that instead.
        const msg = String((err as any)?.message || '');
        if (/\b(401|403|429)\b|API_KEY_INVALID|PERMISSION_DENIED|RESOURCE_EXHAUSTED/.test(msg)) break;
      }
    }
    // 502, not 200: the editor's post() treats any 2xx as success and never
    // reads this body, so a plain 200 here reported "Key N responded" for a key
    // that had just been rejected. The message still rides along for the UI.
    res.status(502).json({ ok: false, message: briefLlmError(lastErr) });
  } catch (err) {
    res.status(502).json({ ok: false, message: briefLlmError(err) });
  }
});

// Persists to state/setup-config.json (not settings.json) and applies live.
// Body { url?, user?, pass? } is validated MERGED over the effective values
// (blank pass = keep), but only submitted fields are persisted, so an
// env-shadowed value is never copied in; env-managed fields are refused.
router.post('/settings/navidrome', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const submitted: { url?: string; user?: string; pass?: string } = {};
    if (typeof b.url === 'string') submitted.url = b.url.trim().replace(/\/$/, '');
    if (typeof b.user === 'string') submitted.user = b.user.trim();
    if (typeof b.pass === 'string' && b.pass !== '') submitted.pass = b.pass;

    const ENV_LOCKS = [
      ['url', 'NAVIDROME_URL'],
      ['user', 'NAVIDROME_USER'],
      ['pass', 'NAVIDROME_PASS'],
    ] as const;
    const locks = navidromeEnvLocks(NAVIDROME_ENV_ENABLED);
    for (const [field, envVar] of ENV_LOCKS) {
      if (submitted[field] !== undefined && locks[field]) {
        return res.status(400).json({
          ok: false,
          error: `${field} is managed by ${envVar} in the root .env — env always wins on boot; remove it there to manage it here`,
        });
      }
    }

    // The merged connection must stay complete; a blank url/user is a cleared
    // field, not "keep".
    const merged = {
      url: submitted.url ?? config.navidrome.url,
      user: submitted.user ?? config.navidrome.user,
      pass: submitted.pass ?? config.navidrome.password,
    };
    if (!merged.url || !merged.user || !merged.pass) {
      return res.status(400).json({ ok: false, error: 'url, user, and pass are all required' });
    }

    await saveSetupConfig({ navidrome: submitted });
    applyNavidromeToLiveConfig(submitted);
    // Both caches describe the OLD server; drop them so the picker can't draw
    // song ids that no longer resolve.
    clearNavidromeCache();
    clearPoolCache();
    queue.log('scheduler', `Navidrome connection updated → ${merged.url} (user ${merged.user})`);
    // auto.m3u URIs carry auth tokens derived from the old password; rebuild.
    // Fire-and-forget so the save isn't held up by Navidrome round-trips.
    refreshAutoPlaylist().catch(err =>
      queue.log('error', `Post-save playlist refresh failed: ${err.message}`),
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err.message || 'save failed' });
  }
});

// Non-mutating test. Merges over the effective values like save does, so Test
// works with the stored password. The wizard's /onboarding/test-navidrome has
// no stored-cred fallback on purpose.
router.post('/settings/navidrome/test', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const url =
    typeof b.url === 'string' && b.url.trim()
      ? b.url.trim().replace(/\/$/, '')
      : config.navidrome.url;
  const user = typeof b.user === 'string' && b.user.trim() ? b.user.trim() : config.navidrome.user;
  const pass = typeof b.pass === 'string' && b.pass ? b.pass : config.navidrome.password;
  if (!url || !user || !pass) {
    return res.json({ ok: false, error: 'url, user, and pass are required' });
  }
  res.json(await subsonic.pingWith({ url, user, pass, client: 'sub-wave-admin' }));
});
