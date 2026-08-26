'use client';

import type { ChangeEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { notify, errorMessage } from '../../lib/notify';
import { normalizeStationLocale } from '../../lib/format';
import { useAdminAuth } from '../../lib/adminAuth';
import {
  AdminResponseError,
  adminResponse,
} from '../../lib/admin-query';
import { V3AlertDialog } from '../ui/alert-dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../ui/select';
import { Card, Btn, Pill, Seg } from './ui';
import { SkeletonForm } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import { cn } from '../../lib/cn';
import ArchivesPanel from './ArchivesPanel';
import BackupPanel from './BackupPanel';
import {
  SETTINGS_AAC_BITRATES,
  SETTINGS_MP3_BITRATES,
  SETTINGS_OPUS_BITRATES,
} from '@/lib/schemas.generated';
import { AlertTriangle } from 'lucide-react';
import {
  SectionHeader, SaveBar, SettingsFieldError, ELEVENLABS_VS_DEFAULTS, FISH_TTS_DEFAULTS,
  type FormState, type FormUpdater, type SettingsData, type SaveSettings,
  type LoudnessSource, type LlmForm, type LlmFallbackForm,
} from './settings/shared';
import {
  SECTIONS, SECTION_GROUPS, RESTART_PATHS, sectionById, type SectionId,
} from './settings/registry';
import { Advanced, SectionChromeProvider } from './settings/section-chrome';
import { SettingsSearch, type SettingsJump } from './settings/SettingsSearch';
import { TtsSection } from './settings/TtsSection';
import { LlmSection } from './settings/LlmSection';
import { SearchSection } from './settings/SearchSection';
import { LibrarySection } from './settings/LibrarySection';
import { StationSection } from './settings/StationSection';
import { ThemeSection } from './settings/ThemeSection';
import { ScrobbleSection } from './settings/ScrobbleSection';
import { LikesSection } from './settings/LikesSection';
import { NavidromeSection } from './settings/NavidromeSection';
import {
  useSettingsMutation,
  useSettingsQuery,
} from './settings/queries';

/**
 * Read one dotted path out of the form. Returns undefined for a missing branch
 * rather than throwing, so a path that names a key a given settings.json has
 * never carried compares equal on both sides and reads as clean.
 */
function atPath(form: FormState | null, path: string): unknown {
  let node: unknown = form;
  for (const key of path.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

const samePath = (a: FormState | null, b: FormState | null, path: string) =>
  JSON.stringify(atPath(a, path) ?? null) === JSON.stringify(atPath(b, path) ?? null);

/**
 * How many individual controls differ between two form branches.
 *
 * Counting LEAVES, not top-level keys: `requests` is one key holding seven
 * fields, and "1 unsaved change" under a card where the operator just edited
 * three of them reads as a bug in the counter.
 */
function countLeafDiffs(a: unknown, b: unknown): number {
  if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) return 0;
  const plain = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  // An array is one control (the TTS corrections list, the compat params
  // table), not one control per row.
  if (!plain(a) || !plain(b)) return 1;
  let n = 0;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    n += countLeafDiffs(a[key], b[key]);
  }
  return n;
}

/**
 * The paths a section owns that differ from the last saved baseline.
 *
 * Diffing against the BASELINE rather than the server's current values is what
 * makes the count survive the 3s refetch: the baseline only moves when a save
 * succeeds, so an operator mid-edit keeps seeing their own change count.
 */
function dirtyPaths(
  form: FormState | null,
  baseline: FormState | null,
  paths: readonly string[],
): string[] {
  if (!form || !baseline) return [];
  return paths.filter(path => !samePath(form, baseline, path));
}

// The three encoder vocabularies, from the mirror rather than re-typed. radio.liq
// has a literal `%mp3(bitrate=…)` branch per value, so each set is genuinely
// fixed — but "fixed" is why a hand-copied list is dangerous rather than safe:
// it drifts silently the one time a value IS added, offering the operator a
// bitrate the schema then refuses (or hiding one it would have accepted).
const MP3_BITRATES = SETTINGS_MP3_BITRATES;
const OPUS_BITRATES = SETTINGS_OPUS_BITRATES;
const AAC_BITRATES = SETTINGS_AAC_BITRATES;

/**
 * Settings keys a save posts under a name the FormState does NOT use.
 *
 * `rebaselineSavedPatch` already re-homes the VALUES (audio.stemCache* is edited
 * as `transitions.*`); anything that scopes by FormState key has to follow the
 * same map or it misses the alias. Discard is the case that bites: rolling back
 * `transitions` while leaving the `audio.stemCacheGb` message on screen parks an
 * error under a value that no longer produced it.
 */
const FORM_KEY_ALIASES: Record<string, readonly string[]> = {
  transitions: ['audio'],
};

/** Does `path` belong to any of these FormState keys, alias included? */
function ownsErrorPath(formKeys: readonly string[], path: string): boolean {
  const under = (key: string) => path === key || path.startsWith(`${key}.`);
  return formKeys.some(key => under(key) || (FORM_KEY_ALIASES[key] ?? []).some(under));
}

/**
 * Replace exactly the errors belonging to the keys this patch carried.
 *
 * Scoped by TOP-LEVEL key, because that is the unit a save button posts and the
 * unit the controller reports against: a `{beds: …}` save owns every
 * `beds.*` error and nothing else. Merging blindly would let a fixed field keep
 * showing its old message; clearing everything would wipe an unrelated
 * section's unresolved error the moment any other control saved.
 */
function mergePatchErrors(
  prev: Record<string, string>,
  patch: Record<string, unknown>,
  next: Record<string, string> | undefined,
): Record<string, string> {
  const owned = Object.keys(patch);
  const isOwned = (path: string) =>
    owned.some((key) => path === key || path.startsWith(`${key}.`));
  const out: Record<string, string> = {};
  for (const [path, message] of Object.entries(prev)) {
    if (!isOwned(path)) out[path] = message;
  }
  for (const [path, message] of Object.entries(next || {})) out[path] = message;
  return out;
}

/**
 * How long a search jump waits for its target card to mount, in animation
 * frames (~1s at 60Hz). Generous on purpose: the cost of waiting is invisible
 * — the scroll simply happens on the frame the card appears — while the cost of
 * giving up early is a jump that silently does nothing.
 */
const JUMP_MAX_FRAMES = 60;

/**
 * Collector for the number boxes in a whole-block save.
 *
 * Archives and the danger zone post EVERY field on every click, so a box the
 * operator cleared and has not refilled rides along with whatever they actually
 * edited — and neither JS coercion fails safely there. `Number('')` is 0, which
 * is a VALID listener buffer and a valid retention window, so saving an AAC
 * toggle would quietly set the buffer to 0s and flag a mixer restart.
 * `parseInt('')` is NaN, which JSON.stringify posts as `null` and fails the
 * whole block with a message pointing at a field nobody touched.
 *
 * So a blank box refuses the save and names itself instead. An explicitly typed
 * `0` still parses, which is what keeps "0 = no limit" on max track length.
 */
function numberFields() {
  const bad: Record<string, string> = {};
  const read = (path: string, raw: string, parse: (s: string) => number) => {
    const text = String(raw).trim();
    // Blank is checked before the parser, not by it: Number('') is a finite 0.
    const n = text ? parse(text) : NaN;
    if (Number.isFinite(n)) return n;
    bad[path] = 'enter a number';
    return 0;
  };
  return {
    bad,
    int: (path: string, raw: string) => read(path, raw, t => parseInt(t, 10)),
    float: (path: string, raw: string) => read(path, raw, t => parseFloat(t)),
    num: (path: string, raw: string) => read(path, raw, Number),
  };
}

const sameForm = (a: FormState, b: FormState) => JSON.stringify(a) === JSON.stringify(b);

/** Mark only the fields represented by a successful patch as clean. */
function rebaselineSavedPatch(
  baseline: FormState,
  current: FormState,
  patch: Record<string, unknown>,
): FormState {
  const next = JSON.parse(JSON.stringify(baseline)) as FormState;
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  const adopt = (
    target: Record<string, unknown>,
    source: Record<string, unknown>,
    shape: Record<string, unknown>,
  ) => {
    for (const [key, value] of Object.entries(shape)) {
      if (!(key in source)) continue;
      if (isRecord(value) && isRecord(target[key]) && isRecord(source[key])) {
        adopt(target[key], source[key], value);
      } else {
        target[key] = source[key];
      }
    }
  };

  const nextRecord = next as unknown as Record<string, unknown>;
  const currentRecord = current as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'audio' && isRecord(value)) {
      adopt(
        next.transitions as unknown as Record<string, unknown>,
        current.transitions as unknown as Record<string, unknown>,
        value,
      );
      continue;
    }
    if (key === 'tts' && isRecord(value)) {
      adopt(
        next.tts as unknown as Record<string, unknown>,
        current.tts as unknown as Record<string, unknown>,
        value,
      );
      if (isRecord(value.kokoro) && 'lang' in value.kokoro) {
        next.kokoroLang = current.kokoroLang;
      }
      continue;
    }
    adopt(nextRecord, currentRecord, { [key]: value });
  }
  return next;
}

export default function SettingsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const settingsQuery = useSettingsQuery<SettingsData>({
    adminFetch,
    enabled: hydrated && !needsAuth,
    refetchInterval: 3_000,
  });
  const data = settingsQuery.data ?? null;
  const err = settingsQuery.error ? errorMessage(settingsQuery.error) : null;
  const [commandBusy, setBusy] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const formBaselineRef = useRef<FormState | null>(null);
  const appliedRevisionRef = useRef(0);
  const pendingFormRevisionRef = useRef<{ revision: number; form: FormState } | null>(null);
  const [pendingRestart, setPendingRestart] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionId>('station');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Portal target for the one sticky save bar. Null while nothing is unsaved,
  // which is what makes every section's SaveBar render nothing when clean.
  const [saveSlot, setSaveSlot] = useState<HTMLElement | null>(null);
  // Dirtiness reported by a section whose state does not ride FormState.
  const [localDirty, setLocalDirty] = useState<Record<string, boolean>>({});
  // Advanced disclosure, per section — remembered while the panel is open so
  // flipping away to check another section and back does not re-collapse it.
  const [advOpen, setAdvOpen] = useState<Record<string, boolean>>({});
  const router = useRouter();

  const reportDirty = useCallback((id: string, dirty: boolean) => {
    setLocalDirty(prev => (!!prev[id] === dirty ? prev : { ...prev, [id]: dirty }));
  }, []);

  const refresh = async () => { await settingsQuery.refetch(); };

  const saveMutation = useSettingsMutation<SettingsData>({ adminFetch });
  const busy = commandBusy || saveMutation.isPending;

  // Jingles / SFX / Beds now live on /admin/imaging; their old ?section
  // deep-links are forwarded so existing bookmarks survive. Read through
  // useSearchParams, not a one-shot window.location, so client-side navigations
  // land too — NavidromeBanner links here from /admin/settings itself, where
  // only the query changes.
  const searchParams = useSearchParams();
  useEffect(() => {
    const s = searchParams.get('section');
    if (s === 'jingles' || s === 'sfx' || s === 'beds') {
      router.replace(`/admin/imaging?tab=${s}`);
      return;
    }
    if (s && SECTIONS.some(x => x.id === s)) setActiveSection(s as SectionId);
  }, [router, searchParams]);

  useEffect(() => {
    if (!data?.values) return;
    const v = data.values;
    const nextForm: FormState = {
      crossfadeDuration: String(v.crossfadeDuration ?? ''),
      maxTrackSeconds: String(v.maxTrackSeconds ?? 0),
      silenceTrim: {
        enabled: v.silenceTrim?.enabled ?? false,
        minGapMs: String(v.silenceTrim?.minGapMs ?? 1500),
      },
      transitions: {
        pairDrain: v.transitions?.pairDrain ?? true,
        stemBlends: v.transitions?.stemBlends ?? false,
        stemCache: v.audio?.stemCache ?? false,
        stemCacheGb: String(v.audio?.stemCacheGb ?? 15),
      },
      archive: {
        enabled: v.archive?.enabled ?? false,
        bitrate: String(v.archive?.bitrate ?? 128),
        retentionDays: String(v.archive?.retentionDays ?? 30),
      },
      stream: {
        opusEnabled: v.stream?.opusEnabled ?? true,
        opusBitrate: String(v.stream?.opusBitrate ?? 96),
        flacEnabled: v.stream?.flacEnabled ?? false,
        aacEnabled: v.stream?.aacEnabled ?? false,
        aacBitrate: String(v.stream?.aacBitrate ?? 192),
        bitrate: String(v.stream?.bitrate ?? 192),
        bufferSeconds: String(v.stream?.bufferSeconds ?? 22),
        oggIcyMetadata: v.stream?.oggIcyMetadata ?? true,
        idleWhenEmpty: v.stream?.idleWhenEmpty ?? false,
        idleAfterMinutes: String(v.stream?.idleAfterMinutes ?? 10),
        maxListeners: String(v.stream?.maxListeners ?? 100),
      },
      loudness: {
        targetLufs: String(v.loudness?.targetLufs ?? -14),
        maxBoostDb: String(v.loudness?.maxBoostDb ?? 6),
        source: v.loudness?.source ?? 'replaygain-then-measured',
      },
      station: v.station ?? '',
      stationDescription: v.stationDescription ?? '',
      timezone: v.timezone ?? '',
      locale: normalizeStationLocale(v.locale),
      privacy: {
        privatePlayer: v.privacy?.privatePlayer ?? false,
        listenerAuth: v.privacy?.listenerAuth ?? false,
        // Arrives as the 'set' sentinel ('' when unset) — never the secret.
        password: v.privacy?.password ?? '',
        publishPersonaSouls: v.privacy?.publishPersonaSouls ?? false,
      },
      requests: {
        enabled: v.requests?.enabled !== false,
        maxPending: String(v.requests?.maxPending ?? 6),
        cooldownSec: String(v.requests?.cooldownSec ?? 60),
        perIpHourlyCap: String(v.requests?.perIpHourlyCap ?? 8),
        globalHourlyCap: String(v.requests?.globalHourlyCap ?? 30),
        repeatCooldownMin: String(v.requests?.repeatCooldownMin ?? 120),
        onePendingPerIp: v.requests?.onePendingPerIp !== false,
      },
      kokoroLang: v.tts?.kokoro?.lang ?? '',
      weather: {
        lat: String(v.weather?.lat ?? ''),
        lng: String(v.weather?.lng ?? ''),
        locationName: v.weather?.locationName ?? '',
        onAirLocation: v.weather?.onAirLocation ?? '',
        units: v.weather?.units === 'imperial' ? 'imperial' : 'metric',
      },
      tts: {
        // Absent (a settings.json predating the key) reads as ON, matching the
        // controller's own coercion in settings.load().
        enabled: v.tts?.enabled !== false,
        defaultEngine: v.tts?.defaultEngine ?? 'piper',
        // Absent block = off, matching the controller's normalizeTtsFallback().
        fallback: {
          enabled: v.tts?.fallback?.enabled === true,
          engine: v.tts?.fallback?.engine ?? 'piper',
          voice: v.tts?.fallback?.voice ?? '',
          cloudProvider: v.tts?.fallback?.cloudProvider ?? 'openai',
        },
        kokoro: { voice: v.tts?.kokoro?.voice ?? 'bf_isabella' },
        chatterbox: { referenceVoice: v.tts?.chatterbox?.referenceVoice ?? '' },
        pocketTts: { voice: v.tts?.pocketTts?.voice ?? 'alba' },
        cloud: {
          enabled: v.tts?.cloud?.enabled ?? false,
          provider: v.tts?.cloud?.provider ?? 'openai',
          model: v.tts?.cloud?.model ?? '',
          voice: v.tts?.cloud?.voice ?? '',
          baseUrl: v.tts?.cloud?.baseUrl ?? '',
          voiceStability: typeof v.tts?.cloud?.voiceStability === 'number' ? v.tts.cloud.voiceStability : ELEVENLABS_VS_DEFAULTS.voiceStability,
          voiceStyle: typeof v.tts?.cloud?.voiceStyle === 'number' ? v.tts.cloud.voiceStyle : ELEVENLABS_VS_DEFAULTS.voiceStyle,
          voiceSimilarityBoost: typeof v.tts?.cloud?.voiceSimilarityBoost === 'number' ? v.tts.cloud.voiceSimilarityBoost : ELEVENLABS_VS_DEFAULTS.voiceSimilarityBoost,
          voiceUseSpeakerBoost: typeof v.tts?.cloud?.voiceUseSpeakerBoost === 'boolean' ? v.tts.cloud.voiceUseSpeakerBoost : ELEVENLABS_VS_DEFAULTS.voiceUseSpeakerBoost,
          temperature: typeof v.tts?.cloud?.temperature === 'number' ? v.tts.cloud.temperature : FISH_TTS_DEFAULTS.temperature,
          topP: typeof v.tts?.cloud?.topP === 'number' ? v.tts.cloud.topP : FISH_TTS_DEFAULTS.topP,
          latency: v.tts?.cloud?.latency === 'low'
            ? 'low'
            : v.tts?.cloud?.latency === 'balanced'
              ? 'balanced'
              : FISH_TTS_DEFAULTS.latency,
          // Extra openai-compatible body fields (issue #1317). Rows are text
          // pairs on the wire too — the controller coerces them to JSON types
          // at send time, so the form never has to guess a value's shape.
          compatParams: Array.isArray(v.tts?.cloud?.compatParams)
            ? v.tts.cloud.compatParams.map(p => ({ key: String(p?.key ?? ''), value: String(p?.value ?? '') }))
            : [],
        },
        remote: { url: v.tts?.remote?.url ?? '' },
        // Per-engine voice level (dB), keyed by engine id — `pocket-tts` (hyphen).
        gainDb: {
          piper: 0,
          kokoro: 0,
          chatterbox: 0,
          'pocket-tts': 0,
          cloud: 0,
          remote: 0,
          ...(v.tts?.gainDb || {}),
        },
        // Per-engine speech speed (×), keyed by engine id — `pocket-tts` (hyphen).
        speed: {
          piper: 1,
          kokoro: 1,
          chatterbox: 1,
          'pocket-tts': 1,
          cloud: 1,
          remote: 1,
          ...(v.tts?.speed || {}),
        },
        corrections: (v.tts?.corrections || []).map(c => ({ from: c.from ?? '', to: c.to ?? '' })),
      },
      llm: {
        provider: v.llm?.provider ?? 'ollama',
        model: v.llm?.model ?? '',
        ollamaUrl: v.llm?.ollamaUrl ?? '',
        numCtx: typeof v.llm?.numCtx === 'number' ? v.llm.numCtx : 16384,
        repeatPenalty: typeof v.llm?.repeatPenalty === 'number' ? v.llm.repeatPenalty : 1.15,
        // Stored providerBaseUrls win; otherwise the legacy single baseUrl seeds
        // the current provider's slot so no URL is lost.
        providerBaseUrls: (() => {
          const llmAny = v.llm as (Partial<LlmForm> & { baseUrl?: string; providerBaseUrls?: Record<string, string> }) | undefined;
          const stored = llmAny?.providerBaseUrls;
          if (stored && typeof stored === 'object') return { ...stored };
          const legacy = llmAny?.baseUrl ?? '';
          const prov = llmAny?.provider ?? 'ollama';
          return legacy ? { [prov]: legacy } : {};
        })(),
        reasoning: !!v.llm?.reasoning,
        toolChoice: v.llm?.toolChoice === 'auto' ? 'auto' : 'required',
        pickerAgent: !!v.llm?.pickerAgent,
        // Fallback must track the controller's default (config.ts, 250): a
        // settings.json written before the field existed omits the key, and
        // seeding the OLD default here means opening Settings and saving any
        // LLM field silently persists it over the new one.
        noRepeatWindow: String(typeof v.llm?.noRepeatWindow === 'number' ? v.llm.noRepeatWindow : 250),
        artistVarietyWindow: String(typeof v.llm?.artistVarietyWindow === 'number' ? v.llm.artistVarietyWindow : 5),
        requestWebResolve: !!v.llm?.requestWebResolve,
        agentTimeoutMs: typeof v.llm?.agentTimeoutMs === 'number' ? v.llm.agentTimeoutMs : 45000,
        pauseWhenEmpty: !!v.llm?.pauseWhenEmpty,
        dailyTokenCap: typeof v.llm?.dailyTokenCap === 'number' ? v.llm.dailyTokenCap : 0,
        budgetSoftPct: typeof v.llm?.budgetSoftPct === 'number' ? v.llm.budgetSoftPct : 80,
        exemptRequests: v.llm?.exemptRequests !== false,
        maxOutputTokens: typeof v.llm?.maxOutputTokens === 'number' ? v.llm.maxOutputTokens : 0,
        discoverySteps: typeof v.llm?.discoverySteps === 'number' ? v.llm.discoverySteps : 0,
        fallback: {
          enabled: !!v.llm?.fallback?.enabled,
          provider: v.llm?.fallback?.provider ?? 'ollama',
          model: v.llm?.fallback?.model ?? '',
          ollamaUrl: v.llm?.fallback?.ollamaUrl ?? '',
          numCtx: typeof v.llm?.fallback?.numCtx === 'number' ? v.llm.fallback.numCtx : 16384,
          repeatPenalty: typeof v.llm?.fallback?.repeatPenalty === 'number' ? v.llm.fallback.repeatPenalty : 1.15,
          discoverySteps: typeof v.llm?.fallback?.discoverySteps === 'number' ? v.llm.fallback.discoverySteps : 0,
          providerBaseUrls: (() => {
            const fbAny = v.llm?.fallback as (LlmFallbackForm & { baseUrl?: string; providerBaseUrls?: Record<string, string> }) | undefined;
            const stored = fbAny?.providerBaseUrls;
            if (stored && typeof stored === 'object') return { ...stored };
            const legacy = fbAny?.baseUrl ?? '';
            const prov = fbAny?.provider ?? 'ollama';
            return legacy ? { [prov]: legacy } : {};
          })(),
          reasoning: !!v.llm?.fallback?.reasoning,
        },
      },
      search: {
        provider: v.search?.provider ?? 'duckduckgo',
        // GET /settings returns the apiKey redacted to 'set' | '' — that
        // round-trips through POST harmlessly (settings.update ignores 'set').
        apiKey: v.search?.apiKey ?? '',
        baseUrl: v.search?.baseUrl ?? '',
      },
      embedding: {
        enabled: v.embedding?.enabled ?? true,
        provider: v.embedding?.provider ?? '',
        model: v.embedding?.model ?? '',
        providerBaseUrls: (() => {
          const stored = (v.embedding as { providerBaseUrls?: Record<string, string> })?.providerBaseUrls;
          if (stored && typeof stored === 'object') return { ...stored };
          // Legacy migration keys by the EFFECTIVE provider (own, else the chat
          // provider), the same key LibrarySection reads and writes.
          const legacy = v.embedding?.baseUrl ?? '';
          const prov = v.embedding?.provider || v.llm?.provider || '';
          return legacy && prov ? { [prov]: legacy } : {};
        })(),
        ollamaUrl: v.embedding?.ollamaUrl ?? '',
        seedCount: String(v.embedding?.seedCount ?? 0),
        knnNeighbours: String(v.embedding?.knnNeighbours ?? 10),
        moodVoteThreshold: String(v.embedding?.moodVoteThreshold ?? 0.4),
        confidenceThreshold: String(v.embedding?.confidenceThreshold ?? 0.35),
        maxActiveLearningRounds: String(v.embedding?.maxActiveLearningRounds ?? 3),
        audioFusionWeight: String(v.embedding?.audioFusionWeight ?? 0.5),
        batchSize: String(v.embedding?.batchSize ?? 25),
        enrichment: {
          lastfmTags: v.embedding?.enrichment?.lastfmTags ?? false,
          lyrics: v.embedding?.enrichment?.lyrics ?? true,
        },
      },
      scrobble: {
        lastfm: {
          enabled: !!v.scrobble?.lastfm?.enabled,
          // 'set' sentinel from getRedacted() — round-trips harmlessly.
          apiKey: v.scrobble?.lastfm?.apiKey ?? '',
          apiSecret: v.scrobble?.lastfm?.apiSecret ?? '',
          sessionKey: v.scrobble?.lastfm?.sessionKey ?? '',
          username: v.scrobble?.lastfm?.username ?? '',
        },
        listenbrainz: {
          enabled: !!v.scrobble?.listenbrainz?.enabled,
          userToken: v.scrobble?.listenbrainz?.userToken ?? '',
          username: v.scrobble?.listenbrainz?.username ?? '',
          baseUrl: v.scrobble?.listenbrainz?.baseUrl ?? '',
        },
      },
      likes: {
        enabled: v.likes?.enabled ?? true,
        starInNavidrome: v.likes?.starInNavidrome ?? true,
        influenceDj: !!v.likes?.influenceDj,
        maxTracks: String(v.likes?.maxTracks ?? 10),
        windowDays: String(v.likes?.windowDays ?? 30),
      },
    };
    const revision = settingsQuery.dataUpdatedAt;
    if (revision && appliedRevisionRef.current !== revision) {
      pendingFormRevisionRef.current = { revision, form: nextForm };
    }
    const pending = pendingFormRevisionRef.current;
    if (!pending) return;
    const baseline = formBaselineRef.current;
    const clean = !form || !baseline || sameForm(form, baseline);
    if (!clean) return;
    if (!form || !sameForm(form, pending.form)) setForm(pending.form);
    formBaselineRef.current = pending.form;
    appliedRevisionRef.current = pending.revision;
    pendingFormRevisionRef.current = null;
  }, [data, form, settingsQuery.dataUpdatedAt]);

  const saveSettings: SaveSettings = async (patch) => {
    try {
      const j = await saveMutation.mutateAsync(patch);
      // The refetch may resolve while this local form is still dirty against
      // its old baseline. Mark only submitted fields clean: an edit in another
      // settings section must continue to hold the queued revision back.
      if (form) {
        const baseline = formBaselineRef.current;
        formBaselineRef.current = baseline
          ? rebaselineSavedPatch(baseline, form, patch)
          : form;
      }
      setFieldErrors((prev) => mergePatchErrors(prev, patch, undefined));
      if (j.requiresRestart) setPendingRestart(true);
      if (j.refreshError) notify.err(`saved, but refresh failed: ${j.refreshError}`);
      else notify.ok(j.requiresRestart ? 'saved, restart the mixer to apply' : 'saved');
      return true;
    } catch (e) {
      const body = e instanceof AdminResponseError
        ? e.body as { fieldErrors?: Record<string, string> }
        : undefined;
      setFieldErrors((prev) => mergePatchErrors(prev, patch, body?.fieldErrors));
      notify.err(errorMessage(e));
      return false;
    }
  };

  const restartMixer = async () => {
    setBusy(true);
    try {
      const r = await adminResponse(adminFetch, '/restart-mixer', { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setPendingRestart(false);
      notify.ok('mixer restarting, give it a few seconds');
    } catch (e) {
      notify.err(errorMessage(e));
    } finally { setBusy(false); }
  };

  const stopStream = async () => {
    setBusy(true);
    try {
      const r = await adminResponse(adminFetch, '/stream-stop', { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      notify.ok('stream stopped, station is off air');
      await refresh();
    } catch (e) {
      notify.err(errorMessage(e));
    } finally { setBusy(false); }
  };

  const startStream = async () => {
    setBusy(true);
    try {
      const r = await adminResponse(adminFetch, '/stream-start', { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      notify.ok('stream started, station is on air');
      await refresh();
    } catch (e) {
      notify.err(errorMessage(e));
    } finally { setBusy(false); }
  };

  /**
   * Post a whole-block patch — unless a number box in it was left blank, in
   * which case name the box and save nothing. See `numberFields`.
   */
  const saveBlock = (n: ReturnType<typeof numberFields>, patch: Record<string, unknown>) => {
    const blanks = Object.keys(n.bad);
    if (blanks.length > 0) {
      setFieldErrors(prev => mergePatchErrors(prev, patch, n.bad));
      notify.err(blanks.length === 1
        ? 'a number field is empty — fill it in before saving'
        : `${blanks.length} number fields are empty — fill them in before saving`);
      return;
    }
    saveSettings(patch);
  };

  /**
   * Archives and the danger zone used to carry a Save button per card — one for
   * the bitrate, one for the retention window, one for each stream mount. Each
   * now folds into the section's one save.
   *
   * Posting the whole block is safe rather than noisy: `settings.update()`
   * change-gates every field in these two blocks against the CURRENT value
   * before deciding it changed, so an untouched field posted alongside an
   * edited one neither writes nor flags a restart. What it is NOT safe against
   * is a blank number box, which is why both go through `saveBlock`.
   */
  const saveArchives = () => {
    if (!form) return;
    const n = numberFields();
    saveBlock(n, {
      archive: {
        enabled: form.archive.enabled,
        bitrate: n.int('archive.bitrate', form.archive.bitrate),
        retentionDays: n.int('archive.retentionDays', form.archive.retentionDays),
      },
    });
  };

  const saveDanger = () => {
    if (!form) return;
    const n = numberFields();
    saveBlock(n, {
      crossfadeDuration: n.float('crossfadeDuration', form.crossfadeDuration),
      maxTrackSeconds: n.int('maxTrackSeconds', form.maxTrackSeconds),
      silenceTrim: {
        enabled: form.silenceTrim.enabled,
        minGapMs: n.int('silenceTrim.minGapMs', form.silenceTrim.minGapMs),
      },
      transitions: {
        pairDrain: form.transitions.pairDrain,
        stemBlends: form.transitions.stemBlends,
      },
      audio: {
        stemCache: form.transitions.stemCache,
        stemCacheGb: n.num('audio.stemCacheGb', form.transitions.stemCacheGb),
      },
      loudness: {
        targetLufs: n.float('loudness.targetLufs', form.loudness.targetLufs),
        maxBoostDb: n.float('loudness.maxBoostDb', form.loudness.maxBoostDb),
        source: form.loudness.source,
      },
      stream: {
        idleWhenEmpty: form.stream.idleWhenEmpty,
        idleAfterMinutes: n.int('stream.idleAfterMinutes', form.stream.idleAfterMinutes),
        opusEnabled: form.stream.opusEnabled,
        opusBitrate: n.int('stream.opusBitrate', form.stream.opusBitrate),
        flacEnabled: form.stream.flacEnabled,
        oggIcyMetadata: form.stream.oggIcyMetadata,
        aacEnabled: form.stream.aacEnabled,
        aacBitrate: n.int('stream.aacBitrate', form.stream.aacBitrate),
        bitrate: n.int('stream.bitrate', form.stream.bitrate),
        bufferSeconds: n.num('stream.bufferSeconds', form.stream.bufferSeconds),
        maxListeners: n.int('stream.maxListeners', form.stream.maxListeners),
      },
    });
  };

  const activeSpec = sectionById(activeSection);
  const baseline = formBaselineRef.current;
  const changedPaths = dirtyPaths(form, baseline, activeSpec?.formKeys ?? []);
  const changedCount = changedPaths.reduce(
    (n, path) => n + countLeafDiffs(atPath(form, path), atPath(baseline, path)),
    0,
  );
  // A section can be dirty in either currency: form paths the panel diffs, or a
  // section-local edit it cannot see (Navidrome creds, which live in
  // setup-config.json rather than settings.json).
  const hasLocalDirty = Object.values(localDirty).some(Boolean);
  const sectionDirty = changedCount > 0 || hasLocalDirty;
  // Warn BEFORE the save, from the mirrored path list. The controller stays the
  // authority afterwards — its `requiresRestart` is what raises the persistent
  // banner above.
  const restartWarn = RESTART_PATHS.some(path =>
    (activeSpec?.formKeys ?? []).some(key => path === key || path.startsWith(`${key}.`))
    && !samePath(form, baseline, path));

  const dirtyLabel = changedCount > 0
    ? `${changedCount} unsaved change${changedCount === 1 ? '' : 's'} in ${activeSpec?.label.toLowerCase() ?? 'this section'}`
    : `unsaved changes in ${activeSpec?.label.toLowerCase() ?? 'this section'}`;

  /** Roll this section's fields back to the last saved baseline, nothing else. */
  const discardSection = () => {
    if (!form || !baseline || !activeSpec) return;
    const next = JSON.parse(JSON.stringify(form)) as Record<string, unknown>;
    const from = baseline as unknown as Record<string, unknown>;
    for (const key of activeSpec.formKeys) {
      if (key in from) next[key] = JSON.parse(JSON.stringify(from[key] ?? null));
    }
    setForm(next as unknown as FormState);
    // The errors belonged to values that no longer exist — same ownership rule
    // the save path uses, so an unrelated section's message survives.
    setFieldErrors(prev => {
      const out: Record<string, string> = {};
      for (const [path, message] of Object.entries(prev)) {
        if (!ownsErrorPath(activeSpec.formKeys, path)) out[path] = message;
      }
      return out;
    });
  };

  /** Search result → switch section, open Advanced if needed, scroll and flash. */
  const jumpTo = useCallback(({ section, anchor, advanced }: SettingsJump) => {
    setActiveSection(section);
    if (advanced) setAdvOpen(prev => ({ ...prev, [section]: true }));
    // The section swap and the disclosure both have to commit before the target
    // card exists to scroll to. A fixed delay is a bet against render time that
    // a 1200-control section can lose, and a lost jump looks exactly like a
    // broken search result — no scroll, no flash, no error. So watch for the
    // card across frames instead, and give up only after JUMP_MAX_FRAMES.
    let frames = 0;
    const settle = () => {
      const el = document.querySelector(`[data-card="${anchor}"]`);
      if (!(el instanceof HTMLElement)) {
        if (frames++ < JUMP_MAX_FRAMES) window.requestAnimationFrame(settle);
        return;
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.setAttribute('data-flash', '');
      window.setTimeout(() => el.removeAttribute('data-flash'), 2600);
    };
    window.requestAnimationFrame(settle);
  }, []);

  const chrome = useMemo(() => ({
    saveSlot,
    reportDirty,
    advOpen: !!advOpen[activeSection],
    setAdvOpen: (open: boolean) =>
      setAdvOpen(prev => ({ ...prev, [activeSection]: open })),
  }), [saveSlot, reportDirty, advOpen, activeSection]);

  return (
    <div className="stack-mobile grid grid-cols-[240px_1fr] items-start gap-6">
      <aside className="grid gap-3.5 sm:sticky sm:top-6">
        {SECTION_GROUPS.map(group => (
          <div key={group} className="grid gap-1">
            <span className="caption pb-1">{group}</span>
            {SECTIONS.filter(s => s.group === group).map(s => {
              const isActive = activeSection === s.id;
              const Icon = s.icon;
              // A section not on screen can only be dirty in form paths — its
              // own component is unmounted, so a section-local edit (music)
              // shows a dot on the active section alone. That is accurate
              // rather than approximate: leaving those sections discards them.
              const dirty = dirtyPaths(form, baseline, s.formKeys).length > 0
                || (isActive && hasLocalDirty);
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveSection(s.id)}
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 border border-ink px-3 py-2.5 text-left font-[inherit] transition-colors',
                    isActive ? 'bg-ink text-bg' : 'bg-[var(--ink-soft)] text-ink hover:bg-ink/10',
                  )}
                >
                  <Icon className="size-4 shrink-0 opacity-80" strokeWidth={2} aria-hidden />
                  <span className="grid min-w-0 flex-1 gap-1">
                    <span className="text-[11px] font-bold tracking-[0.2em] uppercase">
                      {s.label}
                    </span>
                    <span className="text-[9px] tracking-[0.18em] uppercase opacity-70">
                      {s.hint}
                    </span>
                  </span>
                  {dirty && (
                    <span
                      className="size-1.5 shrink-0 bg-vermilion"
                      title="unsaved changes"
                      aria-label="unsaved changes"
                    />
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </aside>

      <div className="grid gap-4">
        <SettingsSearch onJump={jumpTo} />
        {err && <ErrorState error={err} onRetry={refresh} />}
        {pendingRestart && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border border-vermilion bg-vermilion/10 px-4 py-3 text-[12px] text-ink"
          >
            <AlertTriangle className="size-4 shrink-0 text-vermilion" strokeWidth={2} aria-hidden />
            <span className="min-w-0 flex-1">
              <strong className="tracking-[0.08em] uppercase">Saved — not yet on air.</strong>{' '}
              The live stream is still running the previous mixer settings (bitrate, format,
              crossfade, jingle frequency). Restart the mixer to apply what you saved.
            </span>
            <Btn
              sm
              tone="danger"
              className="ml-auto"
              onClick={() => setConfirmRestart(true)}
              disabled={busy || !data}
            >
              Restart mixer to apply
            </Btn>
          </div>
        )}
        {!data && !err && <SkeletonForm fields={5} />}

        {/* One save bar per section, sticky, and only while something is
            unsaved. Each section's own SaveBar portals its note + button into
            the slot below, so the wording, the patch and the error scoping
            still belong to the section that knows them.

            top-[3.25rem] clears AdminShell's own sticky header (top-0, ~49px
            tall) rather than tucking under it like the section rail does — this
            is the one strip that has to stay readable while the operator
            scrolls a long section looking for what they changed. */}
        {sectionDirty && (
          <div className="sticky top-[3.25rem] z-30 grid gap-2.5 border border-vermilion bg-bg p-3 shadow-drawer">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="size-2 shrink-0 bg-vermilion" aria-hidden />
              <span className="text-[11px] font-bold tracking-[0.2em] uppercase">
                {dirtyLabel}
              </span>
              {restartWarn && (
                <Pill tone="accent" dot>needs a mixer restart</Pill>
              )}
              {changedCount > 0 && (
                <Btn sm className="ml-auto" onClick={discardSection} disabled={busy}>
                  Discard
                </Btn>
              )}
            </div>
            <div ref={setSaveSlot} className="grid gap-2.5" />
          </div>
        )}

        <SectionChromeProvider value={chrome}>
        {data && form && (() => {
          const updateForm: FormUpdater = (updater) =>
            setForm(prev => (prev ? updater(prev) : prev));
          return (
          <>
            {activeSection === 'tts' && data.tts && (
              <TtsSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings} fieldErrors={fieldErrors} adminFetch={adminFetch} refresh={refresh}
              />
            )}
            {activeSection === 'llm' && data.llm && (
              <LlmSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings} fieldErrors={fieldErrors} adminFetch={adminFetch} refresh={refresh}
              />
            )}
            {activeSection === 'search' && (
              <SearchSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings} fieldErrors={fieldErrors} adminFetch={adminFetch}
              />
            )}
            {activeSection === 'library' && (
              <LibrarySection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings} fieldErrors={fieldErrors} adminFetch={adminFetch} refresh={refresh}
              />
            )}
            {activeSection === 'station' && (
              <StationSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings} fieldErrors={fieldErrors}
              />
            )}
            {activeSection === 'music' && (
              <NavidromeSection data={data} adminFetch={adminFetch} refresh={refresh} />
            )}
            {activeSection === 'theme' && (
              <ThemeSection
                data={data} busy={busy} saveSettings={saveSettings} fieldErrors={fieldErrors}
                adminFetch={adminFetch}
              />
            )}
            {activeSection === 'scrobble' && (
              <ScrobbleSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings} fieldErrors={fieldErrors} adminFetch={adminFetch} refresh={refresh}
              />
            )}
            {activeSection === 'likes' && (
              <LikesSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings} fieldErrors={fieldErrors}
              />
            )}
          </>
          );
        })()}
        {/* Self-contained panels — each re-calls useAdminAuth and owns its
            own data fetch, so they render outside the data && form guard. */}
        {activeSection === 'archives' && (
          <>
            <ArchivesPanel />
            {form && (
              <Card title="Hourly archive" sub="state/archive/%Y-%m-%d/%H-00.mp3">
                <div className="grid gap-3">
                  <div className="field">
                    <div className="flex items-center gap-2">
                      <Label>Record the broadcast to disk</Label>
                      <Pill tone="ink">restart required</Pill>
                    </div>
                    <div className="flex items-center gap-2">
                      <Seg
                        options={[
                          { id: 'on', label: 'On' },
                          { id: 'off', label: 'Off' },
                        ]}
                        value={form.archive.enabled ? 'on' : 'off'}
                        onChange={id =>
                          setForm(f =>
                            f ? { ...f, archive: { ...f.archive, enabled: id === 'on' } } : f,
                          )
                        }
                      />
                    </div>
                    <SettingsFieldError path="archive.enabled" errors={fieldErrors} />
                    <div className="field-hint">
                      The archive runs a second MP3 encoder 24/7 and is the biggest constant
                      CPU cost in the broadcast container. Turn it off if you don't replay
                      the hourly tapes (issue #137).
                    </div>
                  </div>

                  <div className="field">
                    <div className="flex items-center gap-2">
                      <Label>Archive bitrate</Label>
                      <Pill tone="ink">restart required</Pill>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select
                        value={form.archive.bitrate}
                        onValueChange={v =>
                          setForm(f => (f ? { ...f, archive: { ...f.archive, bitrate: v } } : f))
                        }
                      >
                        <SelectTrigger className="w-32" disabled={!form.archive.enabled} aria-label="Archive bitrate">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {MP3_BITRATES.map(br => (
                            <SelectItem key={br} value={String(br)}>
                              {br} kbps
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="field-hint">
                      Lower bitrate = smaller archives, less encoder CPU
                      (current: {data?.values?.archive?.bitrate ?? '—'} kbps). 128 kbps is the
                      original default.
                    </div>
                  </div>

                  <div className="field">
                    <Label>Keep recordings for</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        className="mono-num w-28"
                        aria-label="Keep recordings for (days)"
                        type="number"
                        min={0}
                        max={3650}
                        step={1}
                        value={form.archive.retentionDays}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setForm(f =>
                            f
                              ? { ...f, archive: { ...f.archive, retentionDays: e.target.value } }
                              : f,
                          )
                        }
                      />
                      <span className="text-[12px] text-muted">days</span>
                    </div>
                    <div className="field-hint">
                      Defaults to 30 days; 0 = keep forever. With a window set, the hourly
                      cleanup deletes whole days of recordings once they age past it. At
                      128 kbps the archive grows ~1.4 GB per day, so an unbounded archive
                      eventually fills the disk. Stations that were already archiving before
                      the 30-day default keep their keep-forever setting. Applies live, no
                      restart.
                    </div>
                  </div>
                </div>
              </Card>
            )}
            <SaveBar
              note="Turning the archive on or off, and changing its bitrate, need a mixer restart. The retention window applies live."
              busy={busy}
              onSave={saveArchives}
              saveLabel="Save archives"
              errors={fieldErrors}
              ownedKeys={['archive']}
            />
          </>
        )}
        {activeSection === 'backup' && <BackupPanel />}
        {activeSection === 'danger' && (
          <>
            <SectionHeader
              eyebrow="danger zone"
              title="Crossfade, stream control, and mixer restart."
              sub="Crossfade is grouped here because it needs a mixer restart to apply. Stream stop and mixer restart both affect every current listener."
              metrics={[
                {
                  n: data?.streamOnAir == null ? '—' : data.streamOnAir ? 'on air' : 'off air',
                  l: 'broadcast',
                  accent: data?.streamOnAir === true,
                },
                { n: `${data?.values?.crossfadeDuration ?? '—'}s`, l: 'crossfade' },
              ]}
            />

            <Card title="Broadcast" sub={data?.streamOnAir === false ? 'currently off air' : 'currently on air'}>
              <div className="grid gap-2">
                {data?.streamOnAir === false ? (
                  <Btn sm tone="accent" onClick={startStream} disabled={busy || !data}>
                    Start stream
                  </Btn>
                ) : (
                  <Btn sm tone="danger" onClick={() => setConfirmStop(true)} disabled={busy || !data || data?.streamOnAir == null}>
                    Stop stream
                  </Btn>
                )}
                <div className="field-hint">
                  Takes the station off air by disconnecting the Icecast mount. A mixer restart brings it back on air.
                </div>
              </div>
            </Card>

            {form && (
              <Card title="Idle pause" sub="silence the programme when nobody is listening">
                <div className="field">
                  <Label>Pause when the room is empty</Label>
                  {/* Seg + "after" + minutes + "min" + Save is wider than a
                      phone card, so the row wraps below 640px. */}
                  <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                    <Seg
                      options={[
                        { id: 'on', label: 'On' },
                        { id: 'off', label: 'Off' },
                      ]}
                      value={form.stream.idleWhenEmpty ? 'on' : 'off'}
                      onChange={id =>
                        setForm(f =>
                          f ? { ...f, stream: { ...f.stream, idleWhenEmpty: id === 'on' } } : f,
                        )
                      }
                    />
                    <span className="text-[12px] text-muted">after</span>
                    <Input
                      className="mono-num w-24"
                      aria-label="Pause after (minutes)"
                      type="number"
                      step={1}
                      min={1}
                      max={1440}
                      value={form.stream.idleAfterMinutes}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        setForm(f =>
                          f
                            ? { ...f, stream: { ...f.stream, idleAfterMinutes: e.target.value } }
                            : f,
                        )
                      }
                    />
                    <span className="text-[12px] text-muted">min</span>
                  </div>
                  <div className="field-hint">
                    After this long with zero listeners the programme pauses mid-track and the DJ
                    goes quiet: no track pulls from Navidrome, no LLM or TTS work. The stream
                    mounts stay up, so any player (VLC, Sonos, the web player) connects normally;
                    playback resumes where it left off within a few seconds of the first listener
                    tuning in. Applies live, no mixer restart.
                  </div>
                </div>
              </Card>
            )}

            <Advanced note="crossfade, transitions, loudness and the extra stream mounts">
            {form && (
              <Card title="Crossfade" sub="track transition overlap">
                <div className="field">
                  <div className="flex items-center gap-2">
                    <Label>Crossfade duration</Label>
                    <Pill tone="ink">restart required</Pill>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      className="mono-num w-28"
                      aria-label="Crossfade duration (seconds)"
                      type="number"
                      step={0.5}
                      max={30}
                      value={form.crossfadeDuration}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        setForm(f => (f ? { ...f, crossfadeDuration: e.target.value } : f))
                      }
                    />
                    <span className="text-[12px] text-muted">sec</span>
                  </div>
                  <SettingsFieldError path="crossfadeDuration" errors={fieldErrors} />
                  <div className="field-hint">
                    Seconds of overlap between tracks (current: {data?.values?.crossfadeDuration}s).
                    Saving flags a pending restart. Apply it with the Mixer card below.
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Stem transitions" sub="pair-aware scheduling + rendered blends">
                <div className="grid gap-3">
                  <div className="field">
                    <Label>Pair-aware transitions</Label>
                    <div className="flex items-center gap-2">
                      <Seg
                        options={[
                          { id: 'on', label: 'On' },
                          { id: 'off', label: 'Off' },
                        ]}
                        value={form.transitions.pairDrain ? 'on' : 'off'}
                        onChange={id =>
                          setForm(f =>
                            f ? { ...f, transitions: { ...f.transitions, pairDrain: id === 'on' } } : f,
                          )
                        }
                      />
                    </div>
                    <div className="field-hint">
                      Holds each pick until its successor is known, so DJ-mode crossfades are
                      sized for the actual pair instead of a blind default. Off reverts to the
                      historical eager hand-off. Applies live; no restart.
                    </div>
                  </div>

                  <div className="field">
                    <Label>Stem cache</Label>
                    <div className="flex items-center gap-2">
                      <Seg
                        options={[
                          { id: 'on', label: 'On' },
                          { id: 'off', label: 'Off' },
                        ]}
                        value={form.transitions.stemCache ? 'on' : 'off'}
                        onChange={id =>
                          setForm(f =>
                            f ? { ...f, transitions: { ...f.transitions, stemCache: id === 'on' } } : f,
                          )
                        }
                      />
                    </div>
                    <div className="field-hint">
                      Keeps the drum/bass/vocal/other stems the heavy analyzer already separates
                      during analysis (typically 13&ndash;25&nbsp;MB per track, oldest evicted past
                      the budget). Needs the heavy analyzer image (Demucs). Turning it on now also
                      backfills: the analysis pass targets tracks with no cached stems, so an
                      already-scanned library fills in over successive runs.
                    </div>
                  </div>

                  <div className="field">
                    <Label>Stem cache budget</Label>
                    <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                      <Input
                        className="mono-num w-28"
                        aria-label="Stem cache budget (GB)"
                        type="number"
                        step={1}
                        min={1}
                        max={1000}
                        value={form.transitions.stemCacheGb}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setForm(f =>
                            f
                              ? { ...f, transitions: { ...f.transitions, stemCacheGb: e.target.value } }
                              : f,
                          )
                        }
                      />
                      <span className="text-sm opacity-70">
                        GB &middot; holds ~
                        {/* /25 mirrors the controller's stem-cache APPROX_TRACK_BYTES
                            ceiling, /13 the field-measured average (#1257). */}
                        {Math.floor(
                          ((Number(form.transitions.stemCacheGb) || 15) * 1024) / 25,
                        ).toLocaleString('en-GB')}
                        &ndash;
                        {Math.floor(
                          ((Number(form.transitions.stemCacheGb) || 15) * 1024) / 13,
                        ).toLocaleString('en-GB')}{' '}
                        tracks
                      </span>
                    </div>
                    <div className="field-hint">
                      How much disk the stem cache may use before the oldest entries are evicted
                      (1&ndash;500&nbsp;GB). A blend only fires when BOTH tracks of a pair are
                      cached, so a budget well under your library size means most seams stay
                      plain crossfades. The backfill stops once the budget is full rather than
                      separating tracks it would immediately evict.
                    </div>
                  </div>

                  <div className="field">
                    <Label>Stem-blend seams</Label>
                    <div className="flex items-center gap-2">
                      <Seg
                        options={[
                          { id: 'on', label: 'On' },
                          { id: 'off', label: 'Off' },
                        ]}
                        value={form.transitions.stemBlends ? 'on' : 'off'}
                        onChange={id =>
                          setForm(f =>
                            f ? { ...f, transitions: { ...f.transitions, stemBlends: id === 'on' } } : f,
                          )
                        }
                      />
                    </div>
                    <div className="field-hint">
                      When two tempo-compatible tracks meet and both have cached stems, the seam
                      airs as a rendered blend — the outgoing track&rsquo;s drums carry under the
                      incoming intro until its own beat drops. Falls back to a plain crossfade on
                      any miss. Needs pair-aware transitions + the stem cache; the Doctor flags a
                      config that can&rsquo;t deliver.
                    </div>
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Max track length" sub="cut over-length tracks on air">
                <div className="field">
                  <Label>Maximum track length</Label>
                  <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                    <Input
                      className="mono-num w-28"
                      aria-label="Maximum track length (seconds)"
                      type="number"
                      step={1}
                      min={0}
                      max={36000}
                      value={form.maxTrackSeconds}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        setForm(f => (f ? { ...f, maxTrackSeconds: e.target.value } : f))
                      }
                    />
                    <span className="text-[12px] text-muted">
                      sec · 0 = no limit · min {data?.values?.minTrackSeconds ?? 30}s
                    </span>
                  </div>
                  <SettingsFieldError path="maxTrackSeconds" errors={fieldErrors} />
                  <div className="field-hint">
                    The DJ won&rsquo;t auto-pick tracks longer than this, handy for hour-long
                    album mixes or DJ sets that keep landing in rotation. Listener requests still
                    play any length, and a show can override this with its own limit (0 there means
                    unlimited). Applies on the next pick; no restart needed.
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Dead-air trim" sub="cut silent gaps off track edges">
                <div className="grid gap-3">
                  <div className="field">
                    <Label>Trim silent edges</Label>
                    <div className="flex items-center gap-2">
                      <Seg
                        options={[
                          { id: 'on', label: 'On' },
                          { id: 'off', label: 'Off' },
                        ]}
                        value={form.silenceTrim.enabled ? 'on' : 'off'}
                        onChange={id =>
                          setForm(f =>
                            f ? { ...f, silenceTrim: { ...f.silenceTrim, enabled: id === 'on' } } : f,
                          )
                        }
                      />
                    </div>
                    <SettingsFieldError path="silenceTrim.enabled" errors={fieldErrors} />
                    <div className="field-hint">
                      Some rips carry a chunk of silence before the music starts, or a long blank
                      after it ends — on air that plays as dead air. With this on, the station
                      skips past the silence and cuts away at the end instead of waiting it out.
                      Needs the track analysed; unanalysed tracks play whole as before.
                    </div>
                  </div>

                  <div className="field">
                    <Label>Shortest gap worth cutting</Label>
                    <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                      <Input
                        className="mono-num w-28"
                        aria-label="Shortest gap worth cutting (milliseconds)"
                        type="number"
                        step={100}
                        min={250}
                        max={30000}
                        value={form.silenceTrim.minGapMs}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setForm(f =>
                            f ? { ...f, silenceTrim: { ...f.silenceTrim, minGapMs: e.target.value } } : f,
                          )
                        }
                      />
                      <span className="text-[12px] text-muted">ms</span>
                    </div>
                    <SettingsFieldError path="silenceTrim.minGapMs" errors={fieldErrors} />
                    <div className="field-hint">
                      Anything shorter than this is left alone. Tracks often open a beat after
                      zero, and albums that segue leave space between songs on purpose — raise
                      this if your library is full of them, lower it to catch smaller gaps.
                      Applies on the next pick; no restart needed.
                    </div>
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Loudness levelling" sub="per-track volume normalisation">
                <div className="grid gap-3">
                  <div className="field">
                    <Label>Loudness source</Label>
                    <Select
                      value={form.loudness.source}
                      onValueChange={v =>
                        setForm(f =>
                          f
                            ? {
                                ...f,
                                loudness: { ...f.loudness, source: v as LoudnessSource },
                              }
                            : f,
                        )
                      }
                    >
                      <SelectTrigger className="w-64" aria-label="Loudness source">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="replaygain-then-measured">
                          ReplayGain tags, then measured
                        </SelectItem>
                        <SelectItem value="replaygain">ReplayGain tags only</SelectItem>
                        <SelectItem value="measured">Measured (acoustic analysis)</SelectItem>
                      </SelectContent>
                    </Select>
                    <div className="field-hint">
                      Where each track&rsquo;s loudness figure comes from. ReplayGain tags (read
                      via Navidrome) are a whole-file stereo measurement, the most accurate when
                      your library carries them. Measured values come from this station&rsquo;s
                      acoustic analysis, which scans only the opening of each track. The default
                      prefers the tag and falls back to the measurement for untagged files.
                    </div>
                  </div>
                  <div className="field">
                    <Label>Target loudness</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        className="mono-num w-28"
                        aria-label="Target loudness (LUFS)"
                        type="number"
                        step={1}
                        min={-23}
                        max={-9}
                        value={form.loudness.targetLufs}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setForm(f =>
                            f ? { ...f, loudness: { ...f.loudness, targetLufs: e.target.value } } : f,
                          )
                        }
                      />
                      <span className="text-[12px] text-muted">LUFS · −23 to −9</span>
                    </div>
                    <div className="field-hint">
                      Every analysed track is pulled toward this level. −14 is the streaming
                      standard (Spotify, YouTube). A quieter target like −16 narrows the gap in
                      mixed libraries: loud modern masters come down more, and quiet dynamic ones
                      (classical, jazz) need less lift to catch up.
                    </div>
                  </div>
                  <div className="field">
                    <Label>Max boost</Label>
                    <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                      <Input
                        className="mono-num w-28"
                        aria-label="Max boost (dB)"
                        type="number"
                        step={1}
                        min={0}
                        max={12}
                        value={form.loudness.maxBoostDb}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setForm(f =>
                            f ? { ...f, loudness: { ...f.loudness, maxBoostDb: e.target.value } } : f,
                          )
                        }
                      />
                      <span className="text-[12px] text-muted">dB · 0 to 12</span>
                    </div>
                    <div className="field-hint">
                      Cap on how far a quiet track is turned up (0 = level down only). Boost is
                      also limited by each track&rsquo;s own measured peak headroom, so raising
                      this won&rsquo;t distort dynamic material; very quiet, dynamic masters
                      simply can&rsquo;t reach the target cleanly. Loud tracks are turned down as
                      far as needed. Applies from the next queued track; no restart, tracks need
                      acoustic analysis (Library → Analyze).
                    </div>
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Opus stream" sub="/stream.opus (Ogg-Opus)">
                <div className="grid gap-3">
                  <div className="field">
                    <div className="flex items-center gap-2">
                      <Label>Serve the secondary Opus mount</Label>
                      <Pill tone="ink">restart required</Pill>
                    </div>
                    <div className="flex items-center gap-2">
                      <Seg
                        options={[
                          { id: 'on', label: 'On' },
                          { id: 'off', label: 'Off' },
                        ]}
                        value={form.stream.opusEnabled ? 'on' : 'off'}
                        onChange={id =>
                          setForm(f =>
                            f ? { ...f, stream: { ...f.stream, opusEnabled: id === 'on' } } : f,
                          )
                        }
                      />
                    </div>
                    <SettingsFieldError path="stream.opusEnabled" errors={fieldErrors} />
                    <div className="field-hint">
                      Off by default. Only Chrome/Edge listeners ever pick Opus (Safari, iOS and
                      Firefox stay on the universal MP3 mount); for them it&apos;s equal-or-better
                      quality at ~half the bandwidth, but it adds a continuous second encoder + a
                      44.1→48 kHz resample. Turn it on if you have Chrome/Edge listeners and want
                      the bandwidth saving. The mandatory <code>/stream.mp3</code> mount serves
                      everyone either way.
                    </div>
                  </div>
                  <div className="field">
                    <div className="flex items-center gap-2">
                      <Label>Bitrate</Label>
                      <Pill tone="ink">restart required</Pill>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select
                        value={form.stream.opusBitrate}
                        onValueChange={v =>
                          setForm(f => (f ? { ...f, stream: { ...f.stream, opusBitrate: v } } : f))
                        }
                      >
                        <SelectTrigger className="w-32" aria-label="Opus bitrate">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {OPUS_BITRATES.map(br => (
                            <SelectItem key={br} value={String(br)}>
                              {br} kbps
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <SettingsFieldError path="stream.opusBitrate" errors={fieldErrors} />
                    <div className="field-hint">
                      96 kbps is transparent for most music; 256/320 suits hifi listeners
                      (current: {data?.values?.stream?.opusBitrate ?? '—'} kbps). Raising it
                      increases bandwidth for <em>every</em> Chrome/Edge listener, since the web
                      player auto-selects this mount.
                    </div>
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="FLAC stream" sub="/stream.flac (Ogg FLAC, lossless)">
                <div className="field">
                  <div className="flex items-center gap-2">
                    <Label>Serve the lossless FLAC mount</Label>
                    <Pill tone="ink">restart required</Pill>
                  </div>
                  <div className="flex items-center gap-2">
                    <Seg
                      options={[
                        { id: 'on', label: 'On' },
                        { id: 'off', label: 'Off' },
                      ]}
                      value={form.stream.flacEnabled ? 'on' : 'off'}
                      onChange={id =>
                        setForm(f =>
                          f ? { ...f, stream: { ...f.stream, flacEnabled: id === 'on' } } : f,
                        )
                      }
                    />
                  </div>
                  <SettingsFieldError path="stream.flacEnabled" errors={fieldErrors} />
                  {form.stream.flacEnabled && (
                    <div className="field-hint">
                      Point a player at{' '}
                      <code>
                        {typeof window !== 'undefined' ? window.location.origin : ''}
                        /stream.flac
                      </code>
                    </div>
                  )}
                  <div className="field-hint">
                    Off by default. A continuous third encoder that losslessly captures the
                    broadcast bus at ~800–900 kbps (≈4× the MP3 mount). It&apos;s a true lossless
                    tier <strong>only when your source files are themselves lossless</strong>{' '}
                    (FLAC/ALAC/WAV); for a lossy-source library (e.g. AAC/MP3) it faithfully
                    carries lossy audio and adds no fidelity over MP3/Opus. Meant for external
                    players (VLC, foobar2000, a network streamer); the web and mobile players
                    stay on MP3/Opus and won&apos;t auto-select it. The mandatory{' '}
                    <code>/stream.mp3</code> mount always serves everyone.
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Ogg metadata" sub="ICY titles on /stream.opus + /stream.flac">
                <div className="field">
                  <div className="flex items-center gap-2">
                    <Label>Push ICY track titles on the Ogg mounts</Label>
                    <Pill tone="ink">restart required</Pill>
                  </div>
                  <div className="flex items-center gap-2">
                    <Seg
                      options={[
                        { id: 'on', label: 'On' },
                        { id: 'off', label: 'Off' },
                      ]}
                      value={form.stream.oggIcyMetadata ? 'on' : 'off'}
                      onChange={id =>
                        setForm(f =>
                          f ? { ...f, stream: { ...f.stream, oggIcyMetadata: id === 'on' } } : f,
                        )
                      }
                    />
                  </div>
                  <SettingsFieldError path="stream.oggIcyMetadata" errors={fieldErrors} />
                  <div className="field-hint">
                    On by default. Sends each track&apos;s title out-of-band (ICY) on the Opus and
                    FLAC mounts, which most internet-radio players and Cast receivers need: they
                    read the in-band Ogg tags only once, at connect, and otherwise stay stuck on
                    the first title. Turn it <strong>off</strong> if your listeners use
                    foobar2000: it reads the in-band tags correctly, and the extra ICY channel
                    breaks its FLAC metadata display. The MP3 and AAC mounts always use ICY and
                    are unaffected either way.
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="AAC stream" sub="/stream.aac (AAC-LC, ADTS)">
                <div className="grid gap-3">
                  <div className="field">
                    <div className="flex items-center gap-2">
                      <Label>Serve the AAC mount</Label>
                      <Pill tone="ink">restart required</Pill>
                    </div>
                    <div className="flex items-center gap-2">
                      <Seg
                        options={[
                          { id: 'on', label: 'On' },
                          { id: 'off', label: 'Off' },
                        ]}
                        value={form.stream.aacEnabled ? 'on' : 'off'}
                        onChange={id =>
                          setForm(f =>
                            f ? { ...f, stream: { ...f.stream, aacEnabled: id === 'on' } } : f,
                          )
                        }
                      />
                    </div>
                    <SettingsFieldError path="stream.aacEnabled" errors={fieldErrors} />
                    {form.stream.aacEnabled && (
                      <div className="field-hint">
                        Point a player at{' '}
                        <code>
                          {typeof window !== 'undefined' ? window.location.origin : ''}
                          /stream.aac
                        </code>
                      </div>
                    )}
                    <div className="field-hint">
                      Off by default. A continuous AAC-LC encoder for reach: players and
                      hardware that decode AAC but not Opus. Aimed at external players; the
                      web and mobile players stay on MP3/Opus and won&apos;t auto-select it.
                      The mandatory <code>/stream.mp3</code> mount serves everyone either way.
                    </div>
                  </div>
                  <div className="field">
                    <div className="flex items-center gap-2">
                      <Label>Bitrate</Label>
                      <Pill tone="ink">restart required</Pill>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select
                        value={form.stream.aacBitrate}
                        onValueChange={v =>
                          setForm(f => (f ? { ...f, stream: { ...f.stream, aacBitrate: v } } : f))
                        }
                      >
                        <SelectTrigger className="w-32" aria-label="AAC bitrate">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {AAC_BITRATES.map(br => (
                            <SelectItem key={br} value={String(br)}>
                              {br} kbps
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <SettingsFieldError path="stream.aacBitrate" errors={fieldErrors} />
                    <div className="field-hint">
                      AAC-LC is transparent around 256 kbps (current:{' '}
                      {data?.values?.stream?.aacBitrate ?? '—'} kbps).
                    </div>
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Stream MP3 bitrate" sub="/stream.mp3">
                <div className="field">
                  <div className="flex items-center gap-2">
                    <Label>Bitrate</Label>
                    <Pill tone="ink">restart required</Pill>
                  </div>
                  <div className="flex items-center gap-2">
                    <Select
                      value={form.stream.bitrate}
                      onValueChange={v =>
                        setForm(f => (f ? { ...f, stream: { ...f.stream, bitrate: v } } : f))
                      }
                    >
                      <SelectTrigger className="w-32" aria-label="MP3 stream bitrate">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {MP3_BITRATES.map(br => (
                          <SelectItem key={br} value={String(br)}>
                            {br} kbps
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <SettingsFieldError path="stream.bitrate" errors={fieldErrors} />
                  <div className="field-hint">
                    Higher bitrate = better quality, more listener bandwidth
                    (current: {data?.values?.stream?.bitrate ?? '—'} kbps). 192 kbps is the
                    original default.
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Listener buffer" sub="all stream mounts">
                <div className="field">
                  <div className="flex items-center gap-2">
                    <Label>Listener buffer</Label>
                    <Pill tone="ink">restart required</Pill>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      className="mono-num w-28"
                      aria-label="Listener buffer (seconds)"
                      type="number"
                      min={0}
                      max={60}
                      step={1}
                      value={form.stream.bufferSeconds}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        setForm(f =>
                          f
                            ? { ...f, stream: { ...f.stream, bufferSeconds: e.target.value } }
                            : f,
                        )
                      }
                    />
                    <span className="text-[12px] text-muted">seconds</span>
                  </div>
                  <SettingsFieldError path="stream.bufferSeconds" errors={fieldErrors} />
                  <div className="field-hint">
                    Icecast primes this much audio when a listener connects. Lower values start
                    closer to live and shorten idle wake-up, but leave less immediate cushion
                    for network stalls; 0 disables the connect burst. Applies on the next
                    broadcast restart. Current: {data?.values?.stream?.bufferSeconds ?? '—'}
                    {' '}seconds.
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Max listeners" sub="Icecast concurrent-connection ceiling">
                <div className="field">
                  <div className="flex items-center gap-2">
                    <Label>Max listeners</Label>
                    <Pill tone="ink">restart required</Pill>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      className="mono-num w-28"
                      aria-label="Max concurrent listeners"
                      type="number"
                      min={1}
                      max={10000}
                      step={1}
                      value={form.stream.maxListeners}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        setForm(f =>
                          f
                            ? { ...f, stream: { ...f.stream, maxListeners: e.target.value } }
                            : f,
                        )
                      }
                    />
                    <span className="text-[12px] text-muted">connections</span>
                  </div>
                  <SettingsFieldError path="stream.maxListeners" errors={fieldErrors} />
                  <div className="field-hint">
                    How many people can be tuned in at once, across all mounts. Icecast
                    refuses connections past this; each one costs bandwidth at the mount&apos;s
                    bitrate, so size it against your upstream. Some countries calculate
                    licensing fees on simultaneous listener capacity, which is the usual
                    reason to set it deliberately rather than leave it at 100. Applies on the
                    next broadcast restart. Current:{' '}
                    {data?.values?.stream?.maxListeners ?? '—'}.
                  </div>
                  <div className="field-hint">
                    <strong>ICECAST_MAX_CLIENTS</strong>{' '}in the environment overrides this —
                    it predates the setting and stays authoritative where it&apos;s set. The
                    broadcast log names the source it used on every boot
                    (<code>max listeners N (from …)</code>), so check there if this field
                    saves but nothing changes.
                  </div>
                </div>
              </Card>
            )}


            </Advanced>

            <Card title="Mixer" sub="apply pending Liquidsoap-level settings">
              <div className="grid gap-2">
                <Btn sm tone="danger" onClick={() => setConfirmRestart(true)} disabled={busy || !data}>
                  Restart mixer
                </Btn>
                <div className="field-hint">
                  Drops the broadcast for ~3–5s. Use after crossfade or jingle frequency changes.
                  {pendingRestart && (
                    <strong className="mt-1 block text-vermilion">
                      Pending settings need a restart to apply.
                    </strong>
                  )}
                </div>
              </div>
            </Card>

            <SaveBar
              note="Crossfade, the encoder settings and the listener buffer only reach the stream after a mixer restart. Idle pause, loudness, dead-air trim and the track-length cap apply live."
              busy={busy}
              onSave={saveDanger}
              saveLabel="Save danger zone"
              errors={fieldErrors}
              ownedKeys={['crossfadeDuration', 'maxTrackSeconds', 'silenceTrim', 'transitions', 'audio', 'loudness', 'stream']}
            />
          </>
        )}
        </SectionChromeProvider>
      </div>

      <V3AlertDialog
        open={confirmRestart}
        onOpenChange={setConfirmRestart}
        title="Restart mixer"
        description="Restart the mixer to apply pending settings? The broadcast will drop for roughly 3–5 seconds."
        confirmLabel="restart mixer"
        danger
        onConfirm={restartMixer}
      />
      <V3AlertDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title="Stop stream"
        description="Take the station off air? The Icecast mount disconnects. Every current listener is dropped and new listeners get nothing until you start the stream again."
        confirmLabel="stop stream"
        danger
        onConfirm={stopStream}
      />
    </div>
  );
}
