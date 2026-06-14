// Admin-gated GET /stats — usage-stats rollups for the admin Stats page.
//
// Aggregates three in-memory call rings — LLM (llm/log.js), TTS (stats.js),
// and the DJ-log (broadcast/queue.js) — into the breakdowns the Stats page
// renders. Everything is since-boot and lossy on restart by design; the raw
// per-call lists stay on /debug, this surface only carries the rollups.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { recentCalls } from '../llm/log.js';
import * as llmProvider from '../llm/provider.js';
import * as settings from '../settings.js';
import { ttsCalls, summarizeLlm, summarizeTts, summarizeDjLog } from '../stats.js';
import { queue } from '../broadcast/queue.js';

export const router = express.Router();

router.get('/stats', requireAdmin, (req, res) => {
  try {
    const llm: any = summarizeLlm(recentCalls);
    llm.provider = llmProvider.providerName();
    llm.activeModel = llmProvider.activeModelLabel();
    // The DJ-agent deadline (admin-tunable, default 45s): past it the agent is
    // killed and falls back to the stateless pool picker. The dash latency gauge
    // anchors its redline to this so "red" means "hitting fallbacks", not an
    // arbitrary ceiling. Mirror of agentDeadline() in broadcast/dj-agent.ts.
    llm.agentTimeoutMs = settings.get().llm?.agentTimeoutMs ?? 45000;

    res.json({
      t: new Date().toISOString(),
      llm,
      tts: summarizeTts(ttsCalls),
      djLog: summarizeDjLog(queue.djLog),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
