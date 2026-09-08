// Admin-gated persona avatar upload + delete, plus community persona install.
// Avatars land in ${STATE_DIR}/persona-avatars/<personaId>.<ext>; the browser
// crops to 512x512 and POSTs a data URL. This route is the single writer, and the
// basename is recorded on the persona's `avatar` field via settings.update(),
// which /persona-avatar/:id reads.

import express from 'express';
import { PERSONA_TTS_INHERIT } from '../schemas/persona.js';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import * as settings from '../settings.js';
import { requireAdmin } from '../middleware/auth.js';
import { readCommunityPersona } from '../personas/community.js';
import { SLUG_RE } from '../skills/loader.js';
import { queue } from '../broadcast/queue.js';

export const router = express.Router();

// Matches the persona id regex in settings.ts; kept local deliberately.
const PERSONA_ID_RE = /^[a-z0-9_]{3,32}$/;
// Hard cap on the DECODED image.
const MAX_AVATAR_BYTES = 300 * 1024;
// Per-route cap: base64 inflates the raw bytes by ~33%, plus the data-URL prefix.
const JSON_BODY_LIMIT = '600kb';

// The data-URL prefix is easy to fake, so check the decoded bytes themselves.
function sniffMime(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (buf.length < 12) return null;
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return 'image/webp';
  return null;
}

function extForMime(mime: string): 'png' | 'jpg' | 'webp' {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'png';
}

// Removes any existing avatar regardless of extension, so a JPEG uploaded over a
// PNG does not orphan the PNG on disk.
async function removeExisting(personaId: string) {
  try {
    const entries = await readdir(settings.PERSONA_AVATAR_DIR);
    await Promise.all(
      entries
        .filter(e => e.startsWith(`${personaId}.`))
        .map(e => unlink(`${settings.PERSONA_AVATAR_DIR}/${e}`).catch(() => {})),
    );
  } catch {
    // Directory doesn't exist yet.
  }
}

async function writeAvatar(personaId: string, dataUrl: string) {
  if (!PERSONA_ID_RE.test(personaId)) {
    throw new Error('invalid persona id');
  }
  await settings.load();
  const personas = settings.get().personas || [];
  if (!personas.some((p: any) => p.id === personaId)) {
    throw new Error('unknown persona');
  }

  const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(dataUrl);
  if (!m) {
    throw new Error('body.dataUrl must be a data:image/(png|jpeg|webp);base64,… URL');
  }
  const declaredMime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new Error('decoded image is empty');
  if (buf.length > MAX_AVATAR_BYTES) {
    throw new Error(`image too large (max ${MAX_AVATAR_BYTES} bytes, got ${buf.length})`);
  }
  const sniffed = sniffMime(buf);
  if (!sniffed) throw new Error('decoded image is not a PNG/JPEG/WebP');
  if (sniffed !== declaredMime) {
    throw new Error(`declared ${declaredMime} but bytes look like ${sniffed}`);
  }

  await mkdir(settings.PERSONA_AVATAR_DIR, { recursive: true });
  await removeExisting(personaId);
  const filename = `${personaId}.${extForMime(sniffed)}`;
  await writeFile(`${settings.PERSONA_AVATAR_DIR}/${filename}`, buf);

  // Resend the whole array: update() validates the full list, and its orphan
  // sweep is what keeps the on-disk files consistent.
  const nextPersonas = personas.map((p: any) =>
    p.id === personaId ? { ...p, avatar: filename } : p,
  );
  await settings.update({ personas: nextPersonas });
  return { ok: true, avatar: filename };
}

async function clearAvatar(personaId: string) {
  if (!PERSONA_ID_RE.test(personaId)) {
    throw new Error('invalid persona id');
  }
  await settings.load();
  const personas = settings.get().personas || [];
  if (!personas.some((p: any) => p.id === personaId)) {
    throw new Error('unknown persona');
  }
  await removeExisting(personaId);
  const nextPersonas = personas.map((p: any) =>
    p.id === personaId ? { ...p, avatar: '' } : p,
  );
  await settings.update({ personas: nextPersonas });
  return { ok: true, avatar: '' };
}

const writeHandler = async (req: express.Request, res: express.Response) => {
  try {
    const dataUrl = String(req.body?.dataUrl ?? '');
    const result = await writeAvatar(String(req.params.id), dataUrl);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

router.post(
  '/personas/:id/avatar',
  requireAdmin,
  express.json({ limit: JSON_BODY_LIMIT }),
  writeHandler,
);
router.put(
  '/personas/:id/avatar',
  requireAdmin,
  express.json({ limit: JSON_BODY_LIMIT }),
  writeHandler,
);

router.delete('/personas/:id/avatar', requireAdmin, async (req, res) => {
  try {
    const result = await clearAvatar(String(req.params.id));
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Installs a community persona as an ordinary roster entry, NOT on air
// (activePersonaId is untouched). A full roster or a duplicate on-air name 409s.
router.post('/personas/community/:slug/install', requireAdmin, async (req, res) => {
  const slug = String(req.params.slug);
  if (!SLUG_RE.test(slug)) {
    return res.status(400).json({ error: `invalid persona slug: ${slug}` });
  }

  const cp = await readCommunityPersona(slug);
  if (!cp) {
    return res.status(404).json({ error: `no such community persona: ${slug}` });
  }

  await settings.load();
  const personas = settings.get().personas || [];
  if (personas.length >= settings.PERSONA_LIMIT) {
    return res.status(409).json({ error: `the roster is full (${settings.PERSONA_LIMIT} personas max) — remove one first` });
  }
  const wanted = cp.displayName.trim().toLowerCase();
  if (personas.some((p: any) => String(p.name).trim().toLowerCase() === wanted)) {
    return res.status(409).json({ error: `a persona named "${cp.displayName}" is already in the roster` });
  }

  // No `id`: settings.update() validates strictly and mints one.
  const persona = {
    name: cp.displayName,
    tagline: cp.tagline || '',
    frequency: cp.frequency,
    scriptLength: cp.scriptLength,
    djMode: cp.djMode,
    linkStyle: cp.linkStyle ?? 'natural',
    humour: cp.humour ?? 5,
    localColour: cp.localColour ?? 5,
    warmth: cp.warmth ?? 5,
    soul: cp.soul,
    language: cp.language || '',
    avatar: '',
    tts: { engine: PERSONA_TTS_INHERIT, cloudProvider: 'openai', voice: '', gainDb: 0, speed: 1 },
    skills: null,
  };

  try {
    await settings.update({ personas: [...personas, persona] });
    const next = settings.get().personas || [];
    const installed = next.find((p: any) => String(p.name).trim().toLowerCase() === wanted) || null;
    queue.log('scheduler', `[personas] community "${slug}" installed via admin UI as "${cp.displayName}"`);
    res.json({ personas: next, persona: installed });
  } catch (err: any) {
    queue.log('error', `POST /personas/community/${slug}/install failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});
