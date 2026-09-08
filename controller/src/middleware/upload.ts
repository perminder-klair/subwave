// In-memory multipart single-file upload for operator media imports. Wraps
// multer so a too-large file or parse error is a JSON 400, not Express's HTML
// error page. express.json() ignores multipart/form-data, so this is per-route.

import multer from 'multer';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

const AUDIO_MAX_BYTES = 25 * 1024 * 1024; // 25 MB — generous for a stinger.
const ZIP_MAX_BYTES = 5 * 1024 * 1024;    // 5 MB — a skill bundle is tiny (text + one small module).
const storage = multer.memoryStorage();

// One named multipart field, capped, with multer errors mapped to a JSON 400.
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

// A skill .zip bundle upload (SKILL.md + optional tool.mjs).
export function zipUpload(field: string, maxBytes = ZIP_MAX_BYTES): RequestHandler {
  return singleUpload(field, maxBytes);
}
