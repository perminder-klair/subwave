// Admin-gated selection rules management. The list is round-tripped wholesale
// — same pattern as webhooks/personas/shows — so settings.update() handles
// validation atomically and the response always reflects the saved state.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import * as settings from '../settings.js';
import * as ruleEngine from '../broadcast/rule-engine.js';

export const router = express.Router();

router.get('/rules', requireAdmin, async (_req, res) => {
  try {
    await settings.load();
    const s = settings.get();
    res.json({
      rules: s.rules || [],
      modes: settings.RULE_MODES,
      sourceKinds: settings.RULE_SOURCE_KINDS,
      forceInsertSourceKinds: settings.RULE_FORCE_INSERT_SOURCE_KINDS,
      cadenceKinds: settings.RULE_CADENCE_KINDS,
      pickStrategies: settings.RULE_PICK_STRATEGIES,
      djBehaviors: settings.RULE_DJ_BEHAVIORS,
      limits: {
        max: settings.RULES_LIMIT,
        trackSlotCap: settings.RULES_TRACK_SLOT_CAP,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/rules', requireAdmin, async (req, res) => {
  try {
    const r = await settings.update({ rules: req.body?.rules });
    // Re-materialise rule-slot m3us against the new rule set. If this fails
    // (Subsonic hiccup) we still saved successfully — the periodic refresh
    // tick will retry.
    ruleEngine.refresh().catch(() => {});
    res.json({
      rules: settings.get().rules || [],
      requiresRestart: r.requiresRestart,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Preview what a rule would do. The rule may be unsaved (the UI sends it in
// the body) so we don't require it to exist in settings yet.
router.post('/rules/test', requireAdmin, async (req, res) => {
  try {
    const out = await ruleEngine.testRule(req.body?.rule);
    if (out.error) return res.status(400).json(out);
    res.json(out);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
