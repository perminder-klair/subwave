// Multipart single-file upload middleware (in-memory) for operator media
// imports — jingles and sound effects. Wraps multer so a too-large file or a
// parse error comes back as a clean JSON 400 instead of Express's default
// HTML error page. The global express.json() body parser doesn't touch
// multipart/form-data, so there's no conflict applying this per-route.

import multer from 'multer';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB — generous for a stinger.
const storage = multer.memoryStorage();

export function audioUpload(field: string, maxBytes = DEFAULT_MAX_BYTES): RequestHandler {
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
