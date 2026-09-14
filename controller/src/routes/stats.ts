// Admin-gated GET /stats — rollups over four in-memory call rings (LLM, TTS,
// DJ-log, listener requests) for the Stats page. Since-boot and lossy on
// restart by design; the raw per-call lists stay on /debug.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { recentCalls } from '../llm/log.js';
import * as llmProvider from '../llm/provider.js';
import * as settings from '../settings.js';
import { ttsCalls, summarizeLlm, summarizeTts, summarizeDjLog, summarizeRequests } from '../stats.js';
import { queue } from '../broadcast/queue.js';
import { recentRequests } from '../broadcast/request-log.js';
import { budgetStatus } from '../broadcast/dj-budget.js';

export const router = express.Router();

router.get('/stats', requireAdmin, (req, res) => {
  try {
    const llm: any = summarizeLlm(recentCalls);
    llm.provider = llmProvider.providerName();
    llm.activeModel = llmProvider.activeModelLabel();
    // Mirror of agentDeadline() in broadcast/dj-agent.ts — the dash anchors its
    // latency redline to it, so "red" means "hitting the pool-picker fallback".
    llm.agentTimeoutMs = settings.get().llm?.agentTimeoutMs ?? 45000;
    // Durable per-UTC-day tally, unlike the rings above. enabled:false with no cap.
    llm.budget = budgetStatus();

    res.json({
      t: new Date().toISOString(),
      llm,
      tts: summarizeTts(ttsCalls),
      djLog: summarizeDjLog(queue.djLog),
      requests: summarizeRequests(recentRequests),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
