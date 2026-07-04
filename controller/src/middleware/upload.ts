// Multipart single-file upload middleware (in-memory) for operator media
// imports — jingles, sound effects, and skill .zip bundles. Wraps multer so a
// too-large file or a parse error comes back as a clean JSON 400 instead of
// Express's default HTML error page. The global express.json() body parser
// doesn't touch multipart/form-data, so there's no conflict applying this
// per-route.

import multer from 'multer';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

const AUDIO_MAX_BYTES = 25 * 1024 * 1024; // 25 MB — generous for a stinger.
const ZIP_MAX_BYTES = 5 * 1024 * 1024;    // 5 MB — a skill bundle is tiny (text + one small module).
const storage = multer.memoryStorage();

// Shared core: a single named multipart field, capped, with multer's errors
// (notably LIMIT_FILE_SIZE) mapped to a JSON 400. Nothing here is media-specific.
function singleUpload(field: string, maxBytes: number): RequestHandler {
  const mw = multer({ storage, limits: { fileSize: maxBytes } }).single(field);
  return (req: Request, res: Response, next: NextFunction) => {
    mw(req, res, (err: unknown) => {
      if (err) {
        const e = err as { code?: string; message?: string };
        const msg = e?.code === 'LIMIT_FILE_SIZE'
          ? `file too large (max ${Math.round(maxBytes / (1024 * 1024))} MB)`
          : (e?.message || 'upload failed');
        return res.status(400).json({ error: msg });
      }
      next();
    });
  };
}

export function audioUpload(field: string, maxBytes = AUDIO_MAX_BYTES): RequestHandler {
  return singleUpload(field, maxBytes);
}

// A skill .zip bundle upload (SKILL.md + optional tool.mjs). Small cap — the
// import route rejects anything that isn't a lean skill bundle anyway.
export function zipUpload(field: string, maxBytes = ZIP_MAX_BYTES): RequestHandler {
  return singleUpload(field, maxBytes);
}
