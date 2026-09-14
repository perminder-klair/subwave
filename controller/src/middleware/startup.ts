import type { RequestHandler } from 'express';

// Listening is not readiness: startup still loads persisted state and reaps the
// previous tagger's pidfile. Accepting a new job before that recovery lets its
// pidfile replace the orphan's, so recovery kills the newly accepted worker.
export function createStartupGate() {
  let ready = false;
  const middleware: RequestHandler = (_req, res, next) => {
    if (ready) return next();
    res.set('Retry-After', '1');
    res.set('Cache-Control', 'no-store');
    res.status(503).json({ status: 'starting', error: 'Controller is starting. Please retry shortly.' });
  };
  return { middleware, markReady: () => { ready = true; } };
}
