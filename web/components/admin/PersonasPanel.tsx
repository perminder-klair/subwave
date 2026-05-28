'use client';

// Personas editor — /admin/personas. The station's roster of DJ identities.
// One persona is "active" at a time (a scheduled Show can override which
// persona is on air for its hour). Each persona owns its name, tagline, talk
// frequency, soul, and full voice (TTS engine + cloud provider + voice).
// The system prompt is one global template shared by every persona.
// Everything POSTs to /settings and applies live — no mixer restart.
import type { ChangeEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { CLOUD_VOICES } from '../../lib/cloudVoices';
import { notify, errorMessage } from '../../lib/notify';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Label } from '../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup,
} from '../ui/select';
import { Card, Btn, Pill, Eyebrow, Seg, Toggle } from './ui';
import { cn } from '../../lib/cn';

const FREQUENCIES = [
  { id: 'quiet',      label: 'Quiet',      desc: 'Talks every 8–20 tracks · station ID once an hour · weather hourly on change.' },
  { id: 'moderate',   label: 'Moderate',   desc: 'Talks every 1–9 tracks · station IDs at :15 and :45 · weather every 30 min on change.' },
  { id: 'aggressive', label: 'Aggressive', desc: 'Talks every 1–3 tracks · station IDs four times an hour · weather every 15 min on change.' },
];
const SCRIPT_LENGTHS = [
  { id: 'concise',  label: 'Concise',  desc: 'Standard one-to-four sentence segments. The default.' },
  { id: 'extended', label: 'Extended', desc: 'Longer, storytelling segments — roughly double the length across intros, links, weather and idents.' },
];
const ENGINES = [
  { id: 'piper',  label: 'Piper' },
  { id: 'kokoro', label: 'Kokoro' },
  { id: 'chatterbox', label: 'Chatterbox' },
  { id: 'pocket-tts', label: 'PocketTTS' },
  { id: 'cloud',  label: 'Cloud' },
];
// Chatterbox reference voice files are validated against this in audio/chatterbox.ts
// — basename only, no path separators, .wav extension, conservative chars.
const CHATTERBOX_VOICE_RE = /^[A-Za-z0-9_.-]{1,80}\.wav$/;
// Sentinel for the empty-string "use the built-in voice" choice — Radix Select
// rejects an empty-string SelectItem value.
const CB_DEFAULT_VOICE = '__cb_default__';
// PocketTTS voice ids — lowercase, allow underscores/hyphens (matches the
// settings-side POCKET_TTS_VOICE_RE).
const POCKET_TTS_VOICE_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const NAME_MAX = 40;
const TAGLINE_MAX = 80;
const SOUL_MAX = 400;
const PROMPT_MIN = 50;
const PROMPT_MAX = 4000;
const PERSONA_MAX = 12;
const KOKORO_RE = /^[a-z]{2}_[a-z0-9]+$/;

interface PersonaTts {
  engine: 'piper' | 'kokoro' | 'chatterbox' | 'pocket-tts' | 'cloud' | string;
  cloudProvider: string;
  voice: string;
}

interface Persona {
  id: string;
  name: string;
  tagline: string;
  frequency: string;
  scriptLength: string;
  soul: string;
  // Stored basename like `p_abc123.png` — empty when no avatar is uploaded.
  // The actual image is served via /api/persona-avatar/<id>; we keep the
  // basename in state only so the form round-trips it on save.
  avatar: string;
  tts: PersonaTts;
  skills: string[];
}

interface FormState {
  personas: Persona[];
  activePersonaId: string;
  useCustomPrompt: boolean;
  systemPrompt: string;
}

interface SkillCatalogEntry {
  name: string;
  label?: string;
  description?: string;
}

interface VoiceOption {
  id: string;
  label: string;
}

interface SettingsResponse {
  values?: {
    personas?: Array<Partial<Persona> & { avatar?: string }>;
    activePersonaId?: string;
    djPrompt?: string;
    tts?: { defaultEngine?: string };
  };
  defaults?: { djPrompt?: string };
  skills?: { catalog?: SkillCatalogEntry[] };
  tts?: {
    kokoroVoices?: VoiceOption[];
    chatterboxVoices?: string[];
    chatterboxVoiceDir?: string;
    pocketTtsVoices?: VoiceOption[];
    available?: Record<string, boolean>;
    cloudProviders?: string[];
  };
  env?: Record<string, unknown>;
}


function clientMintId() {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return 'p_' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// 512×512 output target. The controller hard-caps the decoded image at 300 KB
// and the JSON body at 600 KB; a center-cropped 512×512 WebP from a typical
// phone photo lands in the tens of KB, well under both.
const AVATAR_TARGET_PX = 512;

// DiceBear styles to roll through when the operator clicks Generate. Each
// click picks one at random along with a fresh random seed, so re-clicking
// produces a different face. Lorelei / notionists / personas / open-peeps are
// illustrated humans; bottts-neutral / micah / fun-emoji add a robot/abstract
// option so the operator can keep clicking until they land on a vibe that
// fits the persona. All return PNG at the size we ask for, with permissive
// CORS — the fetch can run in the browser.
const DICEBEAR_STYLES = [
  'lorelei', 'notionists', 'personas', 'open-peeps',
  'micah', 'bottts-neutral', 'fun-emoji',
];

async function fetchDicebearAvatar(): Promise<string> {
  const style = DICEBEAR_STYLES[Math.floor(Math.random() * DICEBEAR_STYLES.length)];
  // Random seed so two clicks never produce the same face.
  const seed = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const url = `https://api.dicebear.com/9.x/${style}/png?seed=${encodeURIComponent(seed)}&size=${AVATAR_TARGET_PX}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DiceBear fetch failed (${res.status})`);
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error || new Error('failed to read DiceBear PNG'));
    r.readAsDataURL(blob);
  });
}

// Resize + center-crop the operator-picked image to a square, returned as a
// compressed (WebP, JPEG fallback) data URL ready for POSTing. Done entirely
// client-side so we never need a server-side image library.
async function fileToAvatarDataUrl(file: File): Promise<string> {
  if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
    throw new Error('please pick a PNG, JPEG, or WebP image');
  }
  if (file.size > 12 * 1024 * 1024) {
    throw new Error('image is over 12 MB — pick something smaller');
  }
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_TARGET_PX;
    canvas.height = AVATAR_TARGET_PX;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_TARGET_PX, AVATAR_TARGET_PX);
    // Compressed export — an uncompressed 512×512 PNG is ~1 MB raw / ~1.33 MB
    // base64, which blows past the controller's 600 KB JSON cap, so only tiny
    // source images used to get through. WebP keeps a typical avatar in the
    // tens-of-KB range and preserves transparency; JPEG is the universal
    // fallback for the rare browser whose canvas can't emit WebP (it silently
    // returns a data:image/png URL in that case).
    const webp = canvas.toDataURL('image/webp', 0.85);
    return webp.startsWith('data:image/webp')
      ? webp
      : canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    bitmap.close?.();
  }
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? '';
  return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase() || '?';
}

function PersonaAvatarPicker(props: {
  persona: Persona;
  tick: number;
  uploading: boolean;
  onPick: (file: File) => void;
  onGenerate: () => void;
  onClear: () => void;
}) {
  const { persona, tick, uploading, onPick, onGenerate, onClear } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The public endpoint serves a 1×1 transparent placeholder when no avatar
  // is set; rather than render that as a tiny grey square, fall back to
  // initials in the admin UI. The ?v=… buster forces a refetch after upload.
  const hasAvatar = !!persona.avatar;
  const src = hasAvatar
    ? `${API_BASE}/persona-avatar/${encodeURIComponent(persona.id)}?v=${tick}`
    : null;
  return (
    <div className="grid gap-2">
      <Label>Avatar</Label>
      <div
        className="grid h-[96px] w-[96px] place-items-center overflow-hidden border border-ink bg-[var(--ink-softer)]"
        aria-label={hasAvatar ? `${persona.name} avatar` : 'No avatar set'}
      >
        {src ? (
          <img
            src={src}
            alt=""
            width={96}
            height={96}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="text-[22px] font-extrabold tracking-[-0.02em] text-muted">
            {initialsFor(persona.name)}
          </span>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
          // Reset so picking the same file twice still fires onChange.
          e.target.value = '';
        }}
      />
      <div className="grid w-[96px] gap-1.5">
        <Btn sm className="w-full justify-center" onClick={() => inputRef.current?.click()} disabled={uploading}>
          {uploading ? '…' : hasAvatar ? 'Replace' : 'Upload'}
        </Btn>
        <Btn sm className="w-full justify-center" onClick={onGenerate} disabled={uploading} title="Random DiceBear avatar — click again for a different one">
          Generate
        </Btn>
        {hasAvatar && (
          <Btn sm tone="danger" className="w-full justify-center" onClick={onClear} disabled={uploading}>
            Remove
          </Btn>
        )}
      </div>
    </div>
  );
}

function personaValid(p: Persona): boolean {
  if (p.name.trim().length < 1 || p.name.trim().length > NAME_MAX) return false;
  if (p.tagline.trim().length > TAGLINE_MAX) return false;
  if (p.soul.trim().length < 1 || p.soul.trim().length > SOUL_MAX) return false;
  const e = p.tts.engine;
  if (e === 'kokoro') return KOKORO_RE.test(p.tts.voice.trim());
  if (e === 'chatterbox') {
    // Empty = use built-in default voice; otherwise must be a plain .wav filename.
    const v = p.tts.voice.trim();
    return v === '' || CHATTERBOX_VOICE_RE.test(v);
  }
  if (e === 'pocket-tts') {
    const v = p.tts.voice.trim();
    return v === '' || POCKET_TTS_VOICE_RE.test(v);
  }
  if (e === 'cloud') {
    const v = p.tts.voice.trim();
    return v.length >= 1 && v.length <= 100;
  }
  return true; // piper — voice ignored
}

// Coerce a persona's `voice` to a value the target engine's server-side
// validator will accept. The `voice` field is shared across engines, so
// switching engines can leave an incompatible value behind (e.g. a Kokoro id
// after switching to Chatterbox). This is the last line of defence before the
// POST — it runs regardless of UI state, so a stale form can't ship a bad save.
function voiceForSave(engine: string, voice: string): string {
  if (engine === 'kokoro') return voice || 'bf_isabella';
  if (engine === 'chatterbox') return CHATTERBOX_VOICE_RE.test(voice) ? voice : '';
  if (engine === 'pocket-tts') return POCKET_TTS_VOICE_RE.test(voice) ? voice : 'alba';
  return voice; // piper ignores voice; cloud carries its own
}

// For a cloud persona: why (if at all) its cloud voice won't actually play —
// its provider's API key is missing. Returns a human sentence, or null when
// the cloud voice is good to go. A persona can look fully configured here yet
// still fall back silently; this surfaces that gap before it airs.
function cloudIssue(persona: Persona | undefined, data: SettingsResponse | null): string | null {
  if (persona?.tts?.engine !== 'cloud') return null;
  // openai-compatible has no env-key convention — the persona's baseUrl +
  // model live globally on settings.tts.cloud and are validated there. Trust
  // that the server is configured if the persona picked this provider.
  if (persona.tts.cloudProvider === 'openai-compatible') return null;
  const envKey = persona.tts.cloudProvider === 'elevenlabs'
    ? 'ELEVENLABS_API_KEY' : 'OPENAI_API_KEY';
  if (data?.env && !data.env[envKey]) {
    return `${envKey} is not set in .env.`;
  }
  return null;
}

export default function PersonasPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // index of the persona being edited in the right pane
  const [focusIdx, setFocusIdx] = useState(0);
  // toggles the system-prompt editor card
  const [showPrompt, setShowPrompt] = useState(false);
  // Bumped on every avatar mutation. Appended as ?v=… so the admin <img>
  // refetches even though the public endpoint caches for an hour — the cache
  // is right for listeners, wrong for the operator who just uploaded.
  const [avatarTick, setAvatarTick] = useState(0);
  // Per-persona "uploading" flag — drives the spinner / disables the buttons
  // while the request is in flight.
  const [uploadingId, setUploadingId] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) return null;
      const j = (await r.json()) as SettingsResponse;
      setData(j); setErr(null);
      return j;
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return null; }
  };

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    const initial = async () => {
      try {
        const r = await adminFetch('/settings');
        if (!r.ok) return null;
        const j = (await r.json()) as SettingsResponse;
        setData(j); setErr(null);
        return j;
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        return null;
      }
    };
    (async () => {
      const j = await initial();
      if (j?.values?.personas) {
        const v = j.values;
        const defaultPrompt = j.defaults?.djPrompt || '';
        const stored = v.djPrompt || '';
        const custom = stored !== '' && stored !== defaultPrompt;
        // Catalog of every skill. A persona with no stored `skills` (legacy /
        // code default) is treated as running all of them.
        const allSkills = (j.skills?.catalog || []).map(s => s.name);
        setForm({
          personas: (v.personas || []).map(p => ({
            id: p.id ?? clientMintId(),
            name: p.name ?? '',
            tagline: p.tagline ?? '',
            frequency: p.frequency ?? 'moderate',
            scriptLength: p.scriptLength ?? 'concise',
            soul: p.soul ?? '',
            avatar: typeof p.avatar === 'string' ? p.avatar : '',
            tts: {
              engine: p.tts?.engine ?? 'piper',
              cloudProvider: p.tts?.cloudProvider ?? 'openai',
              voice: p.tts?.voice ?? 'bf_isabella',
            },
            skills: Array.isArray(p.skills) ? p.skills : allSkills,
          })),
          activePersonaId: v.activePersonaId ?? '',
          useCustomPrompt: custom,
          systemPrompt: custom ? stored : defaultPrompt,
        });
      }
    })();
  }, [hydrated, needsAuth, adminFetch]);

  // ── persona helpers ──────────────────────────────────────────────────────
  const setPersona = (i: number, patch: Partial<Persona>) =>
    setForm(f => f ? { ...f, personas: f.personas.map((p, idx) => (idx === i ? { ...p, ...patch } : p)) } : f);
  const setPersonaTts = (i: number, patch: Partial<PersonaTts>) =>
    setForm(f => f ? { ...f, personas: f.personas.map((p, idx) => (idx === i ? { ...p, tts: { ...p.tts, ...patch } } : p)) } : f);
  const setPersonaSkills = (i: number, skills: string[]) =>
    setForm(f => f ? { ...f, personas: f.personas.map((p, idx) => (idx === i ? { ...p, skills } : p)) } : f);
  const addPersona = () =>
    setForm(f => {
      if (!f) return f;
      if (f.personas.length >= PERSONA_MAX) return f;
      return {
        ...f,
        personas: [...f.personas, {
          id: clientMintId(), name: 'New persona', tagline: '',
          frequency: 'moderate', scriptLength: 'concise', soul: '',
          avatar: '',
          tts: { engine: 'piper', cloudProvider: 'openai', voice: 'bf_isabella' },
          skills: (data?.skills?.catalog || []).map(s => s.name),
        }],
      };
    });
  const removePersona = (i: number) =>
    setForm(f => {
      if (!f) return f;
      if (f.personas.length <= 1) return f;
      const target = f.personas[i];
      if (!target) return f;
      const personas = f.personas.filter((_, idx) => idx !== i);
      const fallback = personas[0]?.id ?? f.activePersonaId;
      const activePersonaId = target.id === f.activePersonaId ? fallback : f.activePersonaId;
      return { ...f, personas, activePersonaId };
    });

  // Avatar mutations talk to the dedicated upload endpoints, then update the
  // local form so the basename round-trips through any subsequent save. Each
  // mutation bumps avatarTick so the <img> cache-buster query string flips.
  const uploadAvatar = async (personaId: string, file: File) => {
    setUploadingId(personaId);
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      const r = await adminFetch(`/personas/${encodeURIComponent(personaId)}/avatar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; avatar?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      const filename = j.avatar || '';
      setForm(f =>
        f
          ? {
              ...f,
              personas: f.personas.map(p =>
                p.id === personaId ? { ...p, avatar: filename } : p,
              ),
            }
          : f,
      );
      setAvatarTick(t => t + 1);
      notify.ok('avatar uploaded');
    } catch (e) {
      notify.err(errorMessage(e));
    } finally {
      setUploadingId(null);
    }
  };

  const generateAvatar = async (personaId: string) => {
    setUploadingId(personaId);
    try {
      const dataUrl = await fetchDicebearAvatar();
      const r = await adminFetch(`/personas/${encodeURIComponent(personaId)}/avatar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; avatar?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      const filename = j.avatar || '';
      setForm(f =>
        f
          ? {
              ...f,
              personas: f.personas.map(p =>
                p.id === personaId ? { ...p, avatar: filename } : p,
              ),
            }
          : f,
      );
      setAvatarTick(t => t + 1);
      notify.ok('avatar generated');
    } catch (e) {
      notify.err(errorMessage(e));
    } finally {
      setUploadingId(null);
    }
  };

  const clearAvatar = async (personaId: string) => {
    setUploadingId(personaId);
    try {
      const r = await adminFetch(`/personas/${encodeURIComponent(personaId)}/avatar`, {
        method: 'DELETE',
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setForm(f =>
        f
          ? {
              ...f,
              personas: f.personas.map(p =>
                p.id === personaId ? { ...p, avatar: '' } : p,
              ),
            }
          : f,
      );
      setAvatarTick(t => t + 1);
      notify.ok('avatar removed');
    } catch (e) {
      notify.err(errorMessage(e));
    } finally {
      setUploadingId(null);
    }
  };

  // ── validation ───────────────────────────────────────────────────────────
  const promptText = form ? form.systemPrompt.trim() : '';
  const promptOk = !form?.useCustomPrompt
    || (promptText.length >= PROMPT_MIN && promptText.length <= PROMPT_MAX && promptText.includes('{name}'));
  const allPersonasOk = form ? form.personas.every(p => personaValid(p)) : false;
  const canSave = !!form && allPersonasOk && promptOk
    && form.personas.some(p => p.id === form.activePersonaId);

  const save = async () => {
    if (!canSave || !form) return;
    setBusy(true);
    try {
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personas: form.personas.map(p => ({
            id: p.id,
            name: p.name.trim(),
            tagline: p.tagline.trim(),
            frequency: p.frequency,
            scriptLength: p.scriptLength,
            soul: p.soul.trim(),
            avatar: p.avatar || '',
            tts: {
              engine: p.tts.engine,
              cloudProvider: p.tts.cloudProvider,
              // Sanitize voice for the target engine. The `voice` field is
              // shared across engines, so a leftover value from a previous
              // engine (e.g. a Kokoro id "bm_george" still in state after
              // switching to Chatterbox) would fail the server's validator.
              // Coerce per-engine here so the save can't ship a bad value:
              //   kokoro     — needs a non-empty id; fall back to bf_isabella
              //   chatterbox — must be a .wav filename or empty (built-in)
              //   piper/cloud — passed through as-is
              voice: voiceForSave(p.tts.engine, p.tts.voice.trim()),
            },
            skills: p.skills,
          })),
          activePersonaId: form.activePersonaId,
          djPrompt: form.useCustomPrompt ? form.systemPrompt.trim() : '',
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      notify.ok('personas saved — applies on the next spoken line');
      await load();
    } catch (e) {
      notify.err(errorMessage(e));
    } finally { setBusy(false); }
  };

  const kokoroVoices = data?.tts?.kokoroVoices || [];
  const pocketTtsVoices = data?.tts?.pocketTtsVoices || [];
  const cloudProviders = data?.tts?.cloudProviders || ['openai', 'elevenlabs'];
  const skillCatalog = data?.skills?.catalog || [];

  if (err) {
    return (
      <div className="grid gap-4">
        <Card title="Personas">
          <div className="text-[13px] text-[var(--danger)]">controller error: {err}</div>
        </Card>
      </div>
    );
  }
  if (!form) {
    return (
      <div className="grid gap-4">
        <Card title="Personas">
          <div className="text-[13px] text-muted italic">loading…</div>
        </Card>
      </div>
    );
  }

  // clamp focus to a valid index after add/remove
  const safeIdx = Math.min(focusIdx, form.personas.length - 1);
  const focused = form.personas[safeIdx];
  if (!focused) {
    return (
      <div className="grid gap-4">
        <Card title="Personas">
          <div className="text-[13px] text-muted italic">no personas configured</div>
        </Card>
      </div>
    );
  }
  const activePersona = form.personas.find(p => p.id === form.activePersonaId);
  const focusedSoulLen = focused.soul.trim().length;
  const focusedSoulOver = focusedSoulLen > SOUL_MAX;
  const focusedOk = personaValid(focused);
  const focusedCloudIssue = cloudIssue(focused, data);
  const activeCloudIssue = activePersona ? cloudIssue(activePersona, data) : null;
  const defaultEngine = data?.values?.tts?.defaultEngine || 'piper';

  const engineLabel = (p: Persona) => {
    if (p.tts.engine === 'kokoro') return `kokoro / ${p.tts.voice.trim() || '—'}`;
    if (p.tts.engine === 'chatterbox') return `chatterbox / ${p.tts.voice.trim() || 'built-in'}`;
    if (p.tts.engine === 'pocket-tts') return `pocket-tts / ${p.tts.voice.trim() || 'alba'}`;
    if (p.tts.engine === 'cloud') return `cloud / ${p.tts.cloudProvider} / ${p.tts.voice.trim() || '—'}`;
    return 'piper';
  };

  return (
    <div className="grid gap-4">
      {/* ── HERO ─────────────────────────────────────────────────────────── */}
      <section className="card">
        <div className="stack-mobile grid grid-cols-[1fr_auto] items-center gap-4 border-b border-ink p-4">
          <div>
            <Eyebrow className="text-vermilion">personas</Eyebrow>
            <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
              The voices on your station.
            </div>
            <div className="mt-1 text-[11px] leading-[1.6] text-muted">
              One persona is on air at a time. A scheduled show can hand the hour to a different one.
              Every change applies live; no mixer restart.
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Btn onClick={() => setShowPrompt(s => !s)}>
              {showPrompt ? 'Hide system prompt' : 'System prompt'}
            </Btn>
            <Btn tone="accent" onClick={addPersona} disabled={form.personas.length >= PERSONA_MAX}>
              + Add persona
            </Btn>
          </div>
        </div>

        {/* Active strip */}
        <div className="flex flex-wrap items-center gap-3 bg-[var(--ink-softer)] p-3.5">
          <span className="caption text-vermilion">● live</span>
          <span className="text-[13px] font-bold">
            {activePersona ? (activePersona.name.trim() || 'Persona') : '—'}
          </span>
          {activePersona?.tagline.trim() && (
            <span className="text-[11px] text-muted">— {activePersona.tagline.trim()}</span>
          )}
          <span className="caption ml-4">
            frequency · {activePersona ? activePersona.frequency : '—'}
          </span>
          <span className="caption">voice · {activePersona ? engineLabel(activePersona) : '—'}</span>
          {activeCloudIssue && (
            <span className="caption text-[var(--danger)]">
              ⚠ cloud voice inactive — speaking via {defaultEngine}
            </span>
          )}
          <span className="caption">override · — (a scheduled show may reassign the hour)</span>
        </div>
      </section>

      {/* ── SYSTEM PROMPT (folded-in feature, toggled from hero) ─────────── */}
      {showPrompt && (
        <Card title="System prompt" sub="shared by every persona">
          <p className="mb-2.5 text-[12px] leading-[1.6] text-muted">
            One template wrapped around every DJ generation, shared by all personas.
            Placeholders: <code>{'{name}'}</code> · <code>{'{soul}'}</code> ·{' '}
            <code>{'{station}'}</code> · <code>{'{location}'}</code>. Most stations never touch this.
          </p>
          <Seg
            value={form.useCustomPrompt ? 'custom' : 'default'}
            options={[{ id: 'default', label: 'Built-in default' }, { id: 'custom', label: 'Custom' }]}
            onChange={v => setForm(f => f ? ({ ...f, useCustomPrompt: v === 'custom' }) : f)}
          />
          {!form.useCustomPrompt ? (
            <div className="mt-3">
              <div className="caption mb-1.5">the DJ uses this built-in template</div>
              <pre className="term max-h-[220px]">
                {data?.defaults?.djPrompt || '(default unavailable)'}
              </pre>
            </div>
          ) : (
            <div className="mt-3">
              <Textarea
                rows={12}
                value={form.systemPrompt}
                maxLength={PROMPT_MAX}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                  setForm(f => f ? ({ ...f, systemPrompt: e.target.value }) : f)
                }
                className={cn(
                  'font-mono text-[12px]',
                  promptOk ? 'border-ink' : 'border-[var(--danger)]',
                )}
              />
              <div className="mt-2.5 flex flex-wrap items-center gap-3">
                <Btn
                  onClick={() => setForm(f => f ? ({ ...f, systemPrompt: data?.defaults?.djPrompt || '' }) : f)}
                  disabled={busy || !data?.defaults?.djPrompt}
                >
                  Restore default text
                </Btn>
                <span className={cn('caption', promptOk ? 'text-muted' : 'text-[var(--danger)]')}>
                  {promptText.length}/{PROMPT_MAX} chars
                  {!promptText.includes('{name}') && ' · missing {name}'}
                  {promptText.length > 0 && promptText.length < PROMPT_MIN && ` · min ${PROMPT_MIN}`}
                </span>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* ── 2-COL ───────────────────────────────────────────────────────── */}
      <div className="stack-mobile grid grid-cols-[280px_1fr] items-start gap-4">
        {/* ROSTER */}
        <div className="grid gap-2.5">
          <span className="caption">roster · {form.personas.length} / {PERSONA_MAX}</span>
          {form.personas.map((p, i) => {
            const isActive = p.id === form.activePersonaId;
            const isFocused = i === safeIdx;
            const valid = personaValid(p);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setFocusIdx(i)}
                className={cn(
                  'grid cursor-pointer gap-1.5 border p-3 text-left font-[inherit]',
                  isFocused
                    ? 'border-[var(--accent)] bg-[var(--card-bg)] outline-2 -outline-offset-4 outline-[var(--accent-soft)]'
                    : 'border-ink bg-transparent',
                )}
              >
                <div className="flex items-center gap-1.5">
                  {isActive && <span className="size-1.5 rounded-full bg-[var(--accent)]" />}
                  <span className="text-[14px] font-extrabold tracking-[-0.01em] text-ink">
                    {p.name.trim() || `Persona ${i + 1}`}
                  </span>
                  {isActive && (
                    <Pill tone="accent" className="ml-auto text-[8px]">on air</Pill>
                  )}
                </div>
                <div className="text-[11px] text-muted">
                  {p.tagline.trim() || 'no tagline'}
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Pill className="text-[8px]">{p.frequency}</Pill>
                  {p.scriptLength === 'extended' && <Pill className="text-[8px]">extended</Pill>}
                  <Pill className="text-[8px]">{p.tts.engine}</Pill>
                  {p.tts.engine !== 'piper' && p.tts.voice.trim() && (
                    <Pill className="text-[8px]">{p.tts.voice.trim()}</Pill>
                  )}
                  <Pill className="text-[8px]">
                    {p.skills.length} skill{p.skills.length === 1 ? '' : 's'}
                  </Pill>
                  {!valid && (
                    <Pill className="border-[var(--danger)] text-[8px] text-[var(--danger)]">incomplete</Pill>
                  )}
                </div>
              </button>
            );
          })}
          <button
            type="button"
            onClick={addPersona}
            disabled={form.personas.length >= PERSONA_MAX}
            className={cn(
              'border border-dashed border-muted bg-transparent p-3 font-[inherit] text-[11px] font-bold tracking-[0.18em] text-muted uppercase',
              form.personas.length >= PERSONA_MAX
                ? 'cursor-not-allowed opacity-40'
                : 'cursor-pointer',
            )}
          >
            {form.personas.length >= PERSONA_MAX ? `maximum ${PERSONA_MAX}` : '+ new persona'}
          </button>
        </div>

        {/* EDITOR */}
        <div className="grid gap-4">
          <Card
            title={`Editing · ${focused.name.trim() || `Persona ${safeIdx + 1}`}`}
            sub={`persona ${safeIdx + 1} of ${form.personas.length}`}
            right={
              <>
                {focused.id === form.activePersonaId
                  ? <Pill tone="accent" className="text-[8px]">on air</Pill>
                  : <Btn sm onClick={() => setForm(f => f ? ({ ...f, activePersonaId: focused.id }) : f)}>Set on air</Btn>}
                <Btn
                  sm
                  tone="danger"
                  onClick={() => { removePersona(safeIdx); setFocusIdx(i => Math.max(0, i - 1)); }}
                  disabled={form.personas.length <= 1}
                  title={form.personas.length <= 1 ? 'At least one persona is required' : 'Remove this persona'}
                >
                  Remove
                </Btn>
              </>
            }
          >
            <div className="stack-mobile grid grid-cols-[96px_1fr] items-start gap-4">
              <PersonaAvatarPicker
                persona={focused}
                tick={avatarTick}
                uploading={uploadingId === focused.id}
                onPick={file => uploadAvatar(focused.id, file)}
                onGenerate={() => generateAvatar(focused.id)}
                onClear={() => clearAvatar(focused.id)}
              />
              <div className="grid gap-4">
                <div className="field">
                  <Label>On-air name</Label>
                  <Input
                    value={focused.name}
                    maxLength={NAME_MAX}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setPersona(safeIdx, { name: e.target.value })}
                    className={focused.name.trim() ? 'border-ink' : 'border-[var(--danger)]'}
                  />
                  <div className="field-hint">
                    Shown in the player and injected into every prompt as <code>{'{name}'}</code>.
                    <span className="ml-2 text-muted">{focused.name.trim().length} / {NAME_MAX}</span>
                  </div>
                </div>
                <div className="field">
                  <Label>Tagline</Label>
                  <Input
                    value={focused.tagline}
                    maxLength={TAGLINE_MAX}
                    placeholder="e.g. late-night drift"
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setPersona(safeIdx, { tagline: e.target.value })}
                  />
                  <div className="field-hint">
                    A short line shown alongside the persona. Optional.
                    <span className="ml-2 text-muted">{focused.tagline.trim().length} / {TAGLINE_MAX}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="rule-label">soul</div>

            <div className="field">
              <Textarea
                rows={7}
                value={focused.soul}
                placeholder="e.g. warm and dry, never corny — observant, favours one good image over a list"
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setPersona(safeIdx, { soul: e.target.value })}
                className={focusedSoulOver || focusedSoulLen === 0 ? 'border-[var(--danger)]' : 'border-ink'}
              />
              <div className="field-hint">
                One short personality sketch. Injected into the prompt as <code>{'{soul}'}</code>.
                <span className={cn('ml-2', focusedSoulOver ? 'text-[var(--danger)]' : 'text-muted')}>
                  {focusedSoulLen} / {SOUL_MAX}
                </span>
              </div>
            </div>

            <div className="rule-label">talk frequency</div>

            <div className="stack-mobile grid grid-cols-[1fr_1fr_1fr] gap-2">
              {FREQUENCIES.map(f => (
                <RadioOption
                  key={f.id}
                  active={f.id === focused.frequency}
                  label={f.label}
                  desc={f.desc}
                  onSelect={() => setPersona(safeIdx, { frequency: f.id })}
                />
              ))}
            </div>

            <div className="rule-label">script length</div>

            <div className="stack-mobile grid grid-cols-[1fr_1fr] gap-2">
              {SCRIPT_LENGTHS.map(s => (
                <RadioOption
                  key={s.id}
                  active={s.id === (focused.scriptLength || 'concise')}
                  label={s.label}
                  desc={s.desc}
                  onSelect={() => setPersona(safeIdx, { scriptLength: s.id })}
                />
              ))}
            </div>
          </Card>

          <Card title="Voice" sub="text-to-speech engine">
            <div className="field mb-3.5">
              <Label>Engine</Label>
              <Seg
                value={focused.tts.engine}
                options={ENGINES}
                onChange={v => {
                  // The `voice` field is shared across engines but each engine
                  // validates it differently — a leftover value from the old
                  // engine (e.g. a Kokoro id like "bm_george") fails the new
                  // engine's check on save. Normalize voice to something the
                  // target engine accepts whenever the engine changes.
                  const patch: Partial<PersonaTts> = { engine: v };
                  const cur = focused.tts.voice.trim();
                  if (v === 'cloud') {
                    const provVoices = CLOUD_VOICES[focused.tts.cloudProvider as keyof typeof CLOUD_VOICES] || [];
                    if (!provVoices.some(pv => pv.id === cur)) {
                      patch.voice = provVoices[0]?.id || cur;
                    }
                  } else if (v === 'kokoro') {
                    if (!KOKORO_RE.test(cur)) patch.voice = 'bf_isabella';
                  } else if (v === 'chatterbox') {
                    // Empty = built-in voice; a real value must be a .wav filename.
                    if (cur && !CHATTERBOX_VOICE_RE.test(cur)) patch.voice = '';
                  } else if (v === 'pocket-tts') {
                    if (!POCKET_TTS_VOICE_RE.test(cur)) patch.voice = 'alba';
                  }
                  setPersonaTts(safeIdx, patch);
                }}
              />
              <div className="field-hint">
                Piper is local &amp; fast. Kokoro is more natural but slower. Chatterbox
                clones a voice from a reference clip (local, opt-in). Cloud routes through
                OpenAI / ElevenLabs.
              </div>
            </div>

            {focused.tts.engine === 'piper' && (
              <div className="field-hint">
                Piper uses its built-in local voice — fast, keyless. No voice selection needed.
              </div>
            )}

            {focused.tts.engine === 'kokoro' && (
              <div className="field max-w-[320px]">
                <Label>Kokoro voice</Label>
                <Select
                  value={focused.tts.voice}
                  onValueChange={val => setPersonaTts(safeIdx, { voice: val })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {!kokoroVoices.some(v => v.id === focused.tts.voice) && (
                        <SelectItem value={focused.tts.voice}>{focused.tts.voice}</SelectItem>
                      )}
                      {kokoroVoices.map(v => <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>)}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <div className="field-hint">The kokoro-onnx voice id for this persona.</div>
              </div>
            )}

            {focused.tts.engine === 'chatterbox' && (() => {
              const cbVoices: string[] = data?.tts?.chatterboxVoices || [];
              const cbDir = 'state/chatterbox-voices/';
              const cbAvailable = data?.tts?.available?.chatterbox !== false;
              return (
                <div className="field max-w-[360px]">
                  {!cbAvailable && (
                    <div className="mb-2.5 border border-[var(--danger)] px-3 py-2.5 text-[11px] leading-[1.6] text-[var(--danger)]">
                      Chatterbox isn’t currently available — it lives in the optional{' '}
                      <code>tts-heavy</code> sidecar. Start it with{' '}
                      <code>docker compose --profile tts-heavy up -d</code> (or set{' '}
                      <code>COMPOSE_PROFILES=tts-heavy</code> in <code>.env</code>).
                      This persona falls back to <strong>{defaultEngine}</strong> until
                      it’s up.
                    </div>
                  )}
                  <Label>Reference voice</Label>
                  <Select
                    value={focused.tts.voice || CB_DEFAULT_VOICE}
                    onValueChange={val => setPersonaTts(safeIdx, { voice: val === CB_DEFAULT_VOICE ? '' : val })}
                  >
                    <SelectTrigger><SelectValue placeholder="Built-in default voice" /></SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value={CB_DEFAULT_VOICE}>Built-in default voice</SelectItem>
                        {cbVoices.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                        {focused.tts.voice && !cbVoices.includes(focused.tts.voice) && (
                          <SelectItem value={focused.tts.voice}>{focused.tts.voice} (missing)</SelectItem>
                        )}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <div className="field-hint">
                    ~5s of clean speech is enough to clone a voice. Drop WAVs into{' '}
                    <code>{cbDir}</code> on the host and they’ll show up here.
                    Chatterbox also voices paralinguistic tags ([laugh], [sigh], …) the
                    DJ may insert.
                  </div>
                </div>
              );
            })()}

            {focused.tts.engine === 'pocket-tts' && (() => {
              const ptAvailable = data?.tts?.available?.['pocket-tts'] !== false;
              return (
                <div className="field max-w-[360px]">
                  {!ptAvailable && (
                    <div className="mb-2.5 border border-[var(--danger)] px-3 py-2.5 text-[11px] leading-[1.6] text-[var(--danger)]">
                      PocketTTS isn’t currently available — it lives in the same optional{' '}
                      <code>tts-heavy</code> sidecar as Chatterbox. Start it with{' '}
                      <code>docker compose --profile tts-heavy up -d</code> (or set{' '}
                      <code>COMPOSE_PROFILES=tts-heavy</code> in <code>.env</code>).
                      This persona falls back to <strong>{defaultEngine}</strong> until
                      it’s up.
                    </div>
                  )}
                  <Label>PocketTTS voice</Label>
                  <Select
                    value={focused.tts.voice || 'alba'}
                    onValueChange={val => setPersonaTts(safeIdx, { voice: val })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {pocketTtsVoices.map(v => (
                          <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>
                        ))}
                        {focused.tts.voice && !pocketTtsVoices.some(v => v.id === focused.tts.voice) && (
                          <SelectItem value={focused.tts.voice}>{focused.tts.voice}</SelectItem>
                        )}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <div className="field-hint">
                    CPU-only, ~6× real-time. Built-in voices cover English, French, German,
                    Italian, Spanish and Portuguese.
                  </div>
                </div>
              );
            })()}

            {focused.tts.engine === 'cloud' && (() => {
              const isCompat = focused.tts.cloudProvider === 'openai-compatible';
              const provVoices = CLOUD_VOICES[focused.tts.cloudProvider as keyof typeof CLOUD_VOICES] || [];
              const voice = focused.tts.voice.trim();
              const isPreset = provVoices.some(v => v.id === voice);
              return (
                <>
                {focusedCloudIssue && (
                  <div className="mb-3.5 border border-[var(--danger)] px-3 py-2.5 text-[11px] leading-[1.6] text-[var(--danger)]">
                    <strong>This cloud voice won’t play.</strong> {focusedCloudIssue}{' '}
                    Until that’s fixed, this persona falls back to <strong>{defaultEngine}</strong>.
                  </div>
                )}
                <div className="stack-mobile grid grid-cols-[1fr_1fr] gap-4">
                  <div className="field">
                    <Label>Cloud provider</Label>
                    <Seg
                      value={focused.tts.cloudProvider}
                      options={cloudProviders.map(id => ({ id, label: id }))}
                      onChange={v => {
                        // Switching provider invalidates the old voice id.
                        // openai-compatible has no curated voices — leave the
                        // field blank so the operator types their own (server
                        // picks its default when blank).
                        const next = v === 'openai-compatible'
                          ? ''
                          : (CLOUD_VOICES[v as keyof typeof CLOUD_VOICES]?.[0]?.id || focused.tts.voice);
                        setPersonaTts(safeIdx, { cloudProvider: v, voice: next });
                      }}
                    />
                    <div className="field-hint">
                      {isCompat
                        ? 'Uses the shared base URL + model from Settings.'
                        : 'Uses the shared API key + model from Settings.'}
                    </div>
                  </div>
                  <div className="field">
                    <Label>Cloud voice</Label>
                    {isCompat ? (
                      <>
                        <Input
                          value={focused.tts.voice}
                          maxLength={100}
                          placeholder="Server-specific (cloning ref or speaker id)"
                          onChange={(e: ChangeEvent<HTMLInputElement>) => setPersonaTts(safeIdx, { voice: e.target.value })}
                        />
                        <div className="field-hint">
                          Server-specific — Chatterbox cloning ref name, Qwen3
                          speaker id, etc. Leave blank to let the server pick.
                        </div>
                      </>
                    ) : (
                      <>
                        <Select
                          value={isPreset ? voice : '__custom__'}
                          onValueChange={val => {
                            if (val !== '__custom__') {
                              setPersonaTts(safeIdx, { voice: val });
                            }
                          }}
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {provVoices.map(v => (
                                <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>
                              ))}
                              <SelectItem value="__custom__">Custom voice id…</SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        {!isPreset && (
                          <Input
                            className={cn('mt-2', voice ? 'border-ink' : 'border-[var(--danger)]')}
                            value={focused.tts.voice}
                            maxLength={100}
                            placeholder="Enter a custom voice id"
                            onChange={(e: ChangeEvent<HTMLInputElement>) => setPersonaTts(safeIdx, { voice: e.target.value })}
                          />
                        )}
                        <div className="field-hint">
                          Pick a default voice, or choose <em>Custom voice id…</em> to enter your own
                          (e.g. an OpenAI voice name or an ElevenLabs voice id).
                        </div>
                      </>
                    )}
                  </div>
                </div>
                </>
              );
            })()}
          </Card>

          <Card title="Skills" sub="autonomous segments this persona runs">
            <p className="mb-2.5 text-[12px] leading-[1.6] text-muted">
              When this persona is on air, only the skills ticked here can fire. A skill must
              also be enabled station-wide on the <strong>Skills</strong> page.
            </p>
            {skillCatalog.length === 0 ? (
              <div className="text-[12px] text-muted italic">
                no skills available
              </div>
            ) : (
              <div className="grid gap-0">
                {skillCatalog.map(s => {
                  const on = focused.skills.includes(s.name);
                  return (
                    <div
                      key={s.name}
                      className="grid grid-cols-[1fr_auto] items-center gap-4 border-b border-dashed border-separator-strong py-3"
                    >
                      <div>
                        <div className="text-[13px] font-bold">{s.label || s.name}</div>
                        <div className="mt-0.5 text-[11px] text-muted">
                          {s.description}
                        </div>
                      </div>
                      <Toggle
                        on={on}
                        onClick={() => setPersonaSkills(
                          safeIdx,
                          on
                            ? focused.skills.filter(n => n !== s.name)
                            : [...focused.skills, s.name],
                        )}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Save bar */}
          <div className="flex flex-wrap items-center gap-3 border border-ink bg-[var(--ink-softer)] p-3">
            <span
              className={cn(
                'size-1.5 flex-none rounded-full',
                canSave ? 'bg-[var(--accent)]' : 'bg-[var(--danger)]',
              )}
            />
            <span className="text-[11px] text-muted">
              {!canSave && !focusedOk
                ? <span className="text-[var(--danger)]">this persona has a missing or invalid field</span>
                : !canSave && !allPersonasOk
                  ? <span className="text-[var(--danger)]">another persona in the roster is incomplete</span>
                  : !canSave && !promptOk
                    ? <span className="text-[var(--danger)]">fix the custom system prompt</span>
                    : 'changes apply on the next spoken line · no mixer restart'}
            </span>
            <span className="ml-auto flex gap-2">
              <Btn onClick={load} disabled={busy}>Discard</Btn>
              <Btn tone="accent" onClick={save} disabled={busy || !canSave}>
                {busy ? 'Saving…' : 'Save persona'}
              </Btn>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

interface RadioOptionProps {
  active: boolean;
  label: ReactNode;
  desc: ReactNode;
  onSelect: () => void;
}

function RadioOption({ active, label, desc, onSelect }: RadioOptionProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'grid cursor-pointer gap-1.5 border p-3 text-left font-[inherit]',
        active
          ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
          : 'border-ink bg-transparent',
      )}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            'size-2.5 rounded-full border',
            active
              ? 'border-[var(--accent)] bg-[var(--accent)]'
              : 'border-ink bg-transparent',
          )}
        />
        <span
          className={cn(
            'text-[11px] font-bold tracking-[0.2em] uppercase',
            active ? 'text-vermilion' : 'text-ink',
          )}
        >
          {label}
        </span>
      </div>
      <div className="text-[10px] leading-[1.5] text-muted">{desc}</div>
    </button>
  );
}
