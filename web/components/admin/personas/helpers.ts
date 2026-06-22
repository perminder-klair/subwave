// Pure-ish helpers for the personas editor: id minting, initials, avatar
// encoding, and the validation/sanitisation used by the container on save.
import type { Persona, SettingsResponse } from './types';
import {
  AVATAR_TARGET_PX, DICEBEAR_STYLES,
  NAME_MAX, TAGLINE_MAX, SOUL_MAX, LANGUAGE_MAX,
  KOKORO_RE, CHATTERBOX_VOICE_RE, POCKET_TTS_VOICE_RE,
} from './constants';

export function clientMintId() {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return 'p_' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
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

export function personaValid(p: Persona): boolean {
  if (p.name.trim().length < 1 || p.name.trim().length > NAME_MAX) return false;
  if (p.tagline.trim().length > TAGLINE_MAX) return false;
  if (p.soul.trim().length < 1 || p.soul.trim().length > SOUL_MAX) return false;
  if (p.language.trim().length > LANGUAGE_MAX) return false;
  const e = p.tts.engine;
  if (e === 'kokoro') return KOKORO_RE.test(p.tts.voice.trim());
  if (e === 'chatterbox') {
    // Empty = use built-in default voice; otherwise must be a plain .wav filename.
    const v = p.tts.voice.trim();
    return v === '' || CHATTERBOX_VOICE_RE.test(v);
  }
  if (e === 'pocket-tts') {
    // Built-in voice id, OR a .wav filename for zero-shot cloning (issue #213),
    // OR empty for the default — matches the server-side validator in settings.ts.
    const v = p.tts.voice.trim();
    return v === '' || POCKET_TTS_VOICE_RE.test(v) || CHATTERBOX_VOICE_RE.test(v);
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
export function voiceForSave(engine: string, voice: string): string {
  if (engine === 'kokoro') return voice || 'bf_isabella';
  if (engine === 'chatterbox') return CHATTERBOX_VOICE_RE.test(voice) ? voice : '';
  // Built-in id or a .wav clone filename both pass through; anything else → default.
  if (engine === 'pocket-tts') return (POCKET_TTS_VOICE_RE.test(voice) || CHATTERBOX_VOICE_RE.test(voice)) ? voice : 'alba';
  return voice; // piper ignores voice; cloud carries its own
}

// For a cloud persona: why (if at all) its cloud voice won't actually play —
// its provider's API key is missing. Returns a human sentence, or null when
// the cloud voice is good to go. A persona can look fully configured here yet
// still fall back silently; this surfaces that gap before it airs.
export function cloudIssue(persona: Persona | undefined, data: SettingsResponse | null): string | null {
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

// One-line voice summary for the active strip / roster cards.
export function engineLabel(p: Persona): string {
  if (p.tts.engine === 'kokoro') return `kokoro / ${p.tts.voice.trim() || '—'}`;
  if (p.tts.engine === 'chatterbox') return `chatterbox / ${p.tts.voice.trim() || 'built-in'}`;
  if (p.tts.engine === 'pocket-tts') return `pocket-tts / ${p.tts.voice.trim() || 'alba'}`;
  if (p.tts.engine === 'cloud') return `cloud / ${p.tts.cloudProvider} / ${p.tts.voice.trim() || '—'}`;
  return `piper / ${p.tts.voice.trim() || 'built-in'}`;
}
