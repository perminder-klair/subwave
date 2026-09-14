// Admin-gated persona routes: avatar upload/delete, the community install, and
// the bundle export/import pair (#1620).
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
//
// The two ways a persona can ARRIVE — a community install and a bundle import —
// share one writer, personas/install.ts. They differ only in where the persona
// object came from; the cap, the duplicate-name refusal, the strict validation
// and the id minting are one decision, made once. The bundle packing/unpacking
// itself lives in personas/bundle.ts.

import express from 'express';
import { PERSONA_TTS_INHERIT } from '../schemas/persona.js';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import * as settings from '../settings.js';
import { requireAdmin } from '../middleware/auth.js';
import { readCommunityPersona } from '../personas/community.js';
import { installPersona } from '../personas/install.js';
import { applyPersonaBundle, buildPersonaBundle } from '../personas/bundle.js';
import { bundleFilename } from '../personas/bundle-pure.js';
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

  // A complete persona object — installPersona() hands it to settings.update(),
  // which validates strictly and mints the id (no valid `id` supplied).
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
    const result = await installPersona(persona);
    if (!result.ok) {
      // A 409 is the operator being told the roster is full or the name is
      // taken — expected, and not booth-log material. A 400 is the save itself
      // refusing, which is what the old catch logged.
      if (result.status !== 409) {
        queue.log('error', `POST /personas/community/${slug}/install failed: ${result.error}`);
      }
      return res.status(result.status).json({ error: result.error });
    }
    queue.log('scheduler', `[personas] community "${slug}" installed via admin UI as "${cp.displayName}"`);
    res.json({ personas: result.personas, persona: result.persona });
  } catch (err: any) {
    queue.log('error', `POST /personas/community/${slug}/install failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /personas/:id/export — download this persona as a single zip: the JSON,
// the reference WAV its engine clones from (chatterbox / pocket-tts only — see
// bundle-pure.personaCloneVoice), and the operator's own jingles whose text
// names this DJ. Whole-station export stays out of scope: that is what
// GET /backup/export already is.
//
// Refuses (409) when the persona names a clone sample this station no longer
// has: the zip would be well-formed and the DJ inside it mute.
// ---------------------------------------------------------------------------
router.get('/personas/:id/export', requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!PERSONA_ID_RE.test(id)) {
      return res.status(400).json({ error: `invalid persona id: ${id}` });
    }
    const built = await buildPersonaBundle(id);
    // A 409 here is the export refusing to ship a persona whose clone sample is
    // gone from this station — the bundle would import 200 into a mute DJ.
    if (!built.ok) return res.status(built.status).json({ error: built.error });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${bundleFilename(String(built.persona.name || ''))}"`,
    );
    res.send(built.zip.toBuffer());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /personas/import — create a persona from a bundle. The body is the raw
// zip (the global express.json parser caps at 600kb and cannot carry it), so a
// route-scoped raw parser buffers it instead — the same shape as
// POST /backup/import, at a cap sized for one DJ's audio rather than a tag DB.
//
// The persona arrives OFF AIR with a minted id, like a community install: this
// route and that one share personas/install.ts rather than each writing the
// roster their own way.
// ---------------------------------------------------------------------------
router.post(
  '/personas/import',
  requireAdmin,
  express.raw({ type: () => true, limit: '50mb' }),
  async (req, res) => {
    try {
      const outcome = await applyPersonaBundle(req.body as Buffer);
      if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
      queue.log(
        'scheduler',
        `[personas] bundle imported as "${outcome.persona?.name || 'persona'}"`
        + `${outcome.voice ? ` (voice ${outcome.voice})` : ''}`
        + `${outcome.jingles.length ? ` (+${outcome.jingles.length} jingle${outcome.jingles.length === 1 ? '' : 's'})` : ''}`,
      );
      res.json({
        personas: outcome.personas,
        persona: outcome.persona,
        voice: outcome.voice,
        jingles: outcome.jingles,
      });
    } catch (err: any) {
      queue.log('error', `POST /personas/import failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  },
);
