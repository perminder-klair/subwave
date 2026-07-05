// Admin-gated persona avatar upload + delete.
//
// Avatars are written to ${STATE_DIR}/persona-avatars/<personaId>.<ext>. The
// browser resizes/crops the source image to 512×512 before POSTing it as a
// data URL, so we only ever accept small (~50–300 KB) PNG/JPEG/WebP payloads.
//
// The dedicated upload route is the single writer; the basename is recorded on
// the persona's `avatar` field via settings.update(), and the public
// /persona-avatar/:id endpoint reads from that field. Magic-byte sniffing
// rejects payloads whose decoded bytes don't match a supported image format,
// so an operator can't smuggle anything else past the data-URL header.

import express from 'express';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import * as settings from '../settings.js';
import { requireAdmin } from '../middleware/auth.js';
import { readCommunityPersona } from '../personas/community.js';
import { SLUG_RE } from '../skills/loader.js';
import { queue } from '../broadcast/queue.js';

export const router = express.Router();

// Match the persona id regex used in settings.ts — kept local to avoid widening
// settings.ts's export surface for a 24-char regex.
const PERSONA_ID_RE = /^[a-z0-9_]{3,32}$/;
// Hard cap on the decoded image. The browser-side resize lands us comfortably
// below this for any reasonable source. Anything bigger almost certainly means
// the operator bypassed the picker.
const MAX_AVATAR_BYTES = 300 * 1024;
// JSON payload cap is set per-route — the base64 body inflates the raw bytes
// by ~33%, plus the data-URL prefix. 600 KB is plenty for a 300 KB image.
const JSON_BODY_LIMIT = '600kb';

// Quick magic-byte sniff. The data-URL prefix is operator-supplied and easy
// to fake; this checks the decoded bytes against the canonical signatures.
function sniffMime(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return 'image/png';
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // WebP: 'RIFF' .... 'WEBP'
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

// Removes any existing avatar file for this persona, regardless of extension —
// re-uploading a JPEG over a previous PNG would otherwise leave the PNG
// behind and the persona.avatar field would (correctly) only point at the
// newer one, so the orphan would just waste disk.
async function removeExisting(personaId: string) {
  try {
    const entries = await readdir(settings.PERSONA_AVATAR_DIR);
    await Promise.all(
      entries
        .filter(e => e.startsWith(`${personaId}.`))
        .map(e => unlink(`${settings.PERSONA_AVATAR_DIR}/${e}`).catch(() => {})),
    );
  } catch {
    // Directory doesn't exist yet — nothing to remove.
  }
}

async function writeAvatar(personaId: string, dataUrl: string) {
  if (!PERSONA_ID_RE.test(personaId)) {
    throw new Error('invalid persona id');
  }
  // settings.load() may not have run yet if this is the first request; the
  // server boot block does run it, but be defensive.
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

  // Record the basename on the persona so /persona-avatar/:id and the
  // /now-playing payload pick it up immediately. We resend the full personas
  // array because settings.update() validates the whole list — the orphan
  // sweep inside update() is what keeps the on-disk files consistent.
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

// ---------------------------------------------------------------------------
// POST /personas/community/:slug/install — append a community catalog persona
// to the station's roster as an ordinary persona: editable, deletable, and NOT
// on air (activePersonaId is untouched — the analogue of a community skill
// arriving disabled). Station-specific fields get the roster defaults: a
// minted id, the piper tts block, no avatar, skills=null ("all skills").
// Rejects a roster at PERSONA_LIMIT and a duplicate on-air name (409) so the
// operator isn't left with two indistinguishable DJs.
// ---------------------------------------------------------------------------
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

  // A complete persona object — settings.update() validates strictly and
  // mints the id (no valid `id` supplied → mintId('p_')).
  const persona = {
    name: cp.displayName,
    tagline: cp.tagline || '',
    frequency: cp.frequency,
    scriptLength: cp.scriptLength,
    djMode: cp.djMode,
    humour: cp.humour ?? 5,
    localColour: cp.localColour ?? 5,
    warmth: cp.warmth ?? 5,
    soul: cp.soul,
    language: cp.language || '',
    avatar: '',
    tts: { engine: 'piper', cloudProvider: 'openai', voice: '', gainDb: 0, speed: 1 },
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
