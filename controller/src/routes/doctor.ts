// Doctor API. Admin-gated throughout — the diagnostics expose provider/host
// detail.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import * as doctor from '../doctor.js';

export const router = express.Router();

router.get('/doctor', requireAdmin, async (_req, res) => {
  try {
    res.json(await doctor.runDoctor());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// SSE: one `section` event per check, then `done` with the assembled report.
// Consumed via fetch + a ReadableStream reader — EventSource cannot carry the
// admin Basic-auth header.
router.get('/doctor/stream', requireAdmin, async (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // defeat any intermediary buffering
  (res as any).flushHeaders?.();
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  try {
    const sections: doctor.DoctorSection[] = [];
    for await (const sec of doctor.runDoctorSections()) {
      sections.push(sec);
      send('section', sec);
    }
    send('done', doctor.finalizeReport(sections));
  } catch (err: any) {
    send('error', { error: err?.message || 'doctor failed' });
  } finally {
    res.end();
  }
});

router.get('/doctor/last', requireAdmin, async (_req, res) => {
  try {
    res.json(await doctor.lastRun());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Compact headline for the admin header badge — safe to poll.
router.get('/doctor/summary', requireAdmin, async (_req, res) => {
  try {
    res.json(await doctor.lastSummary());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Never-throwing ping, cached ~20s so polling every admin page doesn't drip
// Subsonic calls.
router.get('/doctor/navidrome', requireAdmin, async (_req, res) => {
  try {
    res.json(await doctor.navidromeConnectivity());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Takes the report the panel already holds, so the review matches what the
// operator is looking at rather than racing a re-run.
router.post('/doctor/review', requireAdmin, async (req, res) => {
  try {
    const report = req.body?.report;
    if (!report || !Array.isArray(report.sections)) {
      return res.status(400).json({ error: 'missing report' });
    }
    res.json(await doctor.reviewReport(report));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
