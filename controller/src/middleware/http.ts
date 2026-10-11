import express, { type Express, type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { cors } from './cors.js';

export function configureHttp(app: Express): void {
  // Preserve the Express 4 query contract, including repeated and bracketed keys.
  app.set('query parser', 'extended');
  // Cross-origin artwork and audio previews need cross-origin CORP. The web
  // app owns document CSP, and Cloudflare/Caddy own TLS and HSTS.
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginOpenerPolicy: false,
    contentSecurityPolicy: false,
    strictTransportSecurity: false,
  }));
  // Parser failures must carry CORS headers too, so cross-origin clients can read them.
  app.use(cors);
  app.use(express.json({ limit: '600kb' }));
  app.use((req, _res, next) => {
    // Express 5 leaves unparsed bodies undefined. Optional-body routes and
    // schema defaults previously received an empty object in Express 4.
    if (req.body === undefined) req.body = {};
    next();
  });
}

const httpErrorSchema = z.object({
  status: z.number().int().min(400).max(599).optional(),
  type: z.string().optional(),
});

export const httpErrorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (res.headersSent) return next(err);
  const parsed = httpErrorSchema.safeParse(err);
  const status = parsed.success ? parsed.data.status ?? 500 : 500;
  let message = status >= 500 ? 'Internal server error' : 'Request failed';
  if (parsed.success && parsed.data.type === 'entity.parse.failed') message = 'Invalid JSON body';
  else if (status === 413) message = 'Request body too large';
  else if (status === 415) message = 'Unsupported request body encoding';
  else if (status === 400) message = 'Bad request';
  else if (status === 404) message = 'Not found';
  if (status >= 500) {
    console.error({
      event: 'http-request-error',
      method: req.method,
      path: req.path,
      error: err instanceof Error ? err.stack : 'Non-Error rejection',
    });
  }
  res.status(status).json({ error: message });
};
