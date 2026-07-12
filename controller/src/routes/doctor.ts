// Admin-gated Doctor API. GET /doctor runs the health assessment; POST
// /doctor/review hands a report to the LLM for a plain-English read. Both behind
// requireAdmin — the diagnostics expose provider/host detail.
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

// Streaming variant — Server-Sent Events, one `section` event per check as it
// completes, then a final `done` event carrying the assembled report. Lets the
// panel paint findings progressively instead of waiting on the slowest probe.
// Consumed via fetch + a ReadableStream reader (EventSource can't carry the
// admin Basic-auth header).
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

// The last assessment (report + review), cached in the controller. Lets the
// panel show the previous run immediately on mount instead of a blank slate.
router.get('/doctor/last', requireAdmin, async (_req, res) => {
  try {
    res.json(await doctor.lastRun());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Compact health headline (counts + overall) for the admin header badge — no
// section detail, safe to poll.
router.get('/doctor/summary', requireAdmin, async (_req, res) => {
  try {
    res.json(await doctor.lastSummary());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Live-config Navidrome connectivity for the always-on admin banner. Returns
// { ok, reason?, url } from the same never-throwing ping the Doctor's
// connectivity finding uses, cached ~20s so polling every admin page doesn't
// drip Subsonic calls. Cheap and safe to poll.
router.get('/doctor/navidrome', requireAdmin, async (_req, res) => {
  try {
    res.json(await doctor.navidromeConnectivity());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Body: { report: DoctorReport } — the report the panel already has in hand, so
// the review reflects exactly what the operator is looking at (no re-run race).
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
