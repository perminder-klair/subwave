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
