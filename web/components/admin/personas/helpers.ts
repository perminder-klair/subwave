import type { DjPromptPreset, FormState, Persona, SettingsResponse } from './types';
import {
  AVATAR_TARGET_PX, DICEBEAR_STYLES, DIAL_NEUTRAL,
  CHATTERBOX_VOICE_RE, POCKET_TTS_VOICE_RE,
} from './constants';
import { CLOUD_PROVIDER_ENV_KEY, cloudProviderLabel } from '../tts/cloudProviderMeta';

// Client-minted opaque id ('p_' personas, 'dp_' prompt presets). The server
// re-mints anything that fails its ID_RE, so these only need to be unique
// within the form.
export function clientMintId(prefix: string = 'p_') {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return prefix + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// The single defaulting path — used by the initial load, community install and
// Discard (which re-derives from the server response). A second, drifting copy is
// how "discard" ends up reverting to something the server never said.
// A persona with no stored `skills` (legacy / code default) runs them all.
export function personaFromSettings(p: Partial<Persona> | undefined, allSkills: string[]): Persona {
  return {
    id: p?.id ?? clientMintId(),
    name: p?.name ?? '',
    tagline: p?.tagline ?? '',
    frequency: p?.frequency ?? 'moderate',
    scriptLength: p?.scriptLength ?? 'concise',
    djMode: p?.djMode === true,
    humour: typeof p?.humour === 'number' ? p.humour : DIAL_NEUTRAL,
    localColour: typeof p?.localColour === 'number' ? p.localColour : DIAL_NEUTRAL,
    warmth: typeof p?.warmth === 'number' ? p.warmth : DIAL_NEUTRAL,
    soul: p?.soul ?? '',
    language: typeof p?.language === 'string' ? p.language : '',
    avatar: typeof p?.avatar === 'string' ? p.avatar : '',
    tts: {
      engine: p?.tts?.engine ?? 'piper',
      cloudProvider: p?.tts?.cloudProvider ?? 'openai',
      voice: p?.tts?.voice ?? 'bf_isabella',
      gainDb: typeof p?.tts?.gainDb === 'number' ? p.tts.gainDb : 0,
      speed: typeof p?.tts?.speed === 'number' ? p.tts.speed : 1,
    },
    skills: Array.isArray(p?.skills) ? p.skills : allSkills,
  };
}

// The prompt-template library + house rules. An older controller (no
// djPrompts field) degrades to its single custom djPrompt as a lone library
// entry; one without djHouseRules (pre-#1182) degrades to no house rules.
export function promptLibraryFromSettings(
  j: SettingsResponse,
): Pick<FormState, 'djPrompts' | 'activeDjPromptId' | 'djHouseRules'> {
  const v = j.values || {};
  const defaultPrompt = j.defaults?.djPrompt || '';
  let djPrompts: DjPromptPreset[] = Array.isArray(v.djPrompts)
    ? v.djPrompts.map(p => ({
        id: typeof p.id === 'string' && p.id ? p.id : clientMintId('dp_'),
        name: typeof p.name === 'string' ? p.name : '',
        text: typeof p.text === 'string' ? p.text : '',
      }))
    : [];
  let activeDjPromptId = typeof v.activeDjPromptId === 'string' ? v.activeDjPromptId : '';
  if (!Array.isArray(v.djPrompts)) {
    const stored = v.djPrompt || '';
    if (stored !== '' && stored !== defaultPrompt) {
      djPrompts = [{ id: clientMintId('dp_'), name: 'Custom prompt', text: stored }];
      activeDjPromptId = djPrompts[0]!.id;
    }
  }
  if (activeDjPromptId && !djPrompts.some(p => p.id === activeDjPromptId)) {
    activeDjPromptId = '';
  }
  const djHouseRules = typeof v.djHouseRules === 'string' ? v.djHouseRules : '';
  return { djPrompts, activeDjPromptId, djHouseRules };
}

// null when the controller returned no roster at all.
export function formFromSettings(j: SettingsResponse | null): FormState | null {
  if (!j?.values?.personas) return null;
  const allSkills = (j.skills?.catalog || []).map(s => s.name);
  return {
    personas: (j.values.personas || []).map(p => personaFromSettings(p, allSkills)),
    activePersonaId: j.values.activePersonaId ?? '',
    ...promptLibraryFromSettings(j),
  };
}

// Two normalisations: skills are a set, not a list (toggling one off and back on
// reorders the array without changing meaning), and `avatar` is excluded because
// avatar mutations POST to their own endpoint and are already durable.
export function personasEqual(a: Persona | undefined, b: Persona | undefined): boolean {
  if (!a || !b) return a === b;
  const canonical = (p: Persona) =>
    JSON.stringify({ ...p, avatar: '', skills: [...p.skills].sort() });
  return canonical(a) === canonical(b);
}

export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? '';
  return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase() || '?';
}

export async function fetchDicebearAvatar(): Promise<string> {
  const style = DICEBEAR_STYLES[Math.floor(Math.random() * DICEBEAR_STYLES.length)];
  // Random seed so two clicks never produce the same face.
  const seed = Math.random().toString(36).slice(2) + Date.now().toString(36);
  // admin-query-imperative: random-avatar-download
  const res = await fetch(
    `https://api.dicebear.com/9.x/${style}/png?seed=${encodeURIComponent(seed)}&size=${AVATAR_TARGET_PX}`,
  );
  if (!res.ok) throw new Error(`DiceBear fetch failed (${res.status})`);
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error || new Error('failed to read DiceBear PNG'));
    r.readAsDataURL(blob);
  });
}

// Resize + center-crop to a square client-side, so no server-side image library
// is needed.
export async function fileToAvatarDataUrl(file: File): Promise<string> {
  if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
    throw new Error('please pick a PNG, JPEG, or WebP image');
  }
  if (file.size > 12 * 1024 * 1024) {
    throw new Error('image is over 12 MB, pick something smaller');
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
    // An uncompressed 512×512 PNG is ~1.33 MB base64, past the controller's 600 KB
    // JSON cap. WebP keeps a typical avatar in the tens of KB and preserves
    // transparency; a browser whose canvas can't emit WebP silently returns a
    // data:image/png URL, hence the JPEG fallback.
    const webp = canvas.toDataURL('image/webp', 0.85);
    return webp.startsWith('data:image/webp')
      ? webp
      : canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    bitmap.close?.();
  }
}

// `voice` is shared across engines, so switching engines can leave an incompatible
// value behind (a Kokoro id after switching to Chatterbox). Runs regardless of UI
// state — the last line of defence before the POST.
export function voiceForSave(engine: string, voice: string): string {
  if (engine === 'kokoro') return voice || 'bf_isabella';
  if (engine === 'chatterbox') return CHATTERBOX_VOICE_RE.test(voice) ? voice : '';
  // Built-in id or a .wav clone filename both pass through; anything else → default.
  if (engine === 'pocket-tts') return (POCKET_TTS_VOICE_RE.test(voice) || CHATTERBOX_VOICE_RE.test(voice)) ? voice : 'alba';
  if (engine === 'remote') return voice; // free text, forwarded as-is
  return voice; // piper ignores voice; cloud carries its own
}

// Why this persona's cloud voice won't play, or null when it will.
//
// The controller's readiness flag (`cloudByProvider`) folds TWO causes into one
// boolean: no credentials, and the station-wide `tts.cloud.enabled` switch being
// off. Reporting them with one sentence sent operators to hunt for a key they
// had already set — visibly so next to the provider picker's own KEY SET badge,
// which reads env presence directly. So credentials are checked first and the
// readiness flag only speaks for what's left: the station switch.
export function cloudIssue(persona: Persona | undefined, data: SettingsResponse | null): string | null {
  if (persona?.tts?.engine !== 'cloud') return null;
  const provider = persona.tts.cloudProvider;
  // openai-compatible has no env-key convention — its URL, model, and optional
  // bearer live in tts.cloud settings rather than state/secrets.env.
  if (provider === 'openai-compatible') return null;
  const readiness = data?.tts?.available?.cloudByProvider;
  const ready = readiness && provider in readiness ? readiness[provider] : undefined;
  if (ready === true) return null;

  const envKey = CLOUD_PROVIDER_ENV_KEY[provider];
  // `data.env` absent means the settings payload hasn't landed; stay quiet
  // rather than accusing a key of being missing before we can see it.
  if (envKey && data?.env && !data.env[envKey]) {
    return `${envKey} is not configured in Settings.`;
  }
  if (ready === false) {
    return `${cloudProviderLabel(provider)} has a key on file, but Cloud TTS is switched off for the station. Turn it on under Settings → Voice.`;
  }
  return null;
}

export function engineLabel(p: Persona): string {
  if (p.tts.engine === 'kokoro') return `kokoro / ${p.tts.voice.trim() || '—'}`;
  if (p.tts.engine === 'chatterbox') return `chatterbox / ${p.tts.voice.trim() || 'built-in'}`;
  if (p.tts.engine === 'pocket-tts') return `pocket-tts / ${p.tts.voice.trim() || 'alba'}`;
  if (p.tts.engine === 'cloud') return `cloud / ${p.tts.cloudProvider} / ${p.tts.voice.trim() || '—'}`;
  if (p.tts.engine === 'remote') return `remote / ${p.tts.voice.trim() || '—'}`;
  return `piper / ${p.tts.voice.trim() || 'built-in'}`;
}
