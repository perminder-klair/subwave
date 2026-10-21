// Admin-gated GET /stats — rollups over four in-memory call rings (LLM, TTS,
// DJ-log, listener requests) for the Stats page. Since-boot and lossy on
// restart by design; the raw per-call lists stay on /debug. The one durable
// section is `transitions`, the seam record read back from library.db plays.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { recentCalls, generationHealthSnapshot, contextMeasurements, failoverRoutingSnapshot } from '../llm/log.js';
import * as llmProvider from '../llm/provider.js';
import * as settings from '../settings.js';
import { ttsCalls, shortlistPicks, summarizeLlm, summarizeTts, summarizeDjLog, summarizeRequests, summarizeShortlistPicks } from '../stats.js';
import { queue } from '../broadcast/queue.js';
import { recentRequests } from '../broadcast/request-log.js';
import { budgetStatus } from '../broadcast/dj-budget.js';
import * as db from '../music/library-db.js';

export const router = express.Router();

// Null when library.db is not open (boot, a failed open): the rest of the page
// is in-memory and must still render without it.
function transitionsOrNull() {
  try {
    return db.transitionStats();
  } catch {
    return null;
  }
}

router.get('/stats', requireAdmin, (req, res) => {
  try {
    // Mirror of agentDeadline() in broadcast/dj-agent.ts. The dash anchors its
    // latency redline to it and goes red on `deadlineHits`, the failed calls
    // that ran it out, so "red" still means "hitting the fallbacks": the needle
    // reads successful calls only, which finish under the deadline.
    const agentTimeoutMs = settings.get().llm?.agentTimeoutMs ?? 45000;
    const llm: any = summarizeLlm(recentCalls, { agentTimeoutMs });
    llm.provider = llmProvider.providerName();
    llm.activeModel = llmProvider.activeModelLabel();
    llm.agentTimeoutMs = agentTimeoutMs;
    // Durable per-UTC-day tally, unlike the rings above. enabled:false with no cap.
    llm.budget = budgetStatus();
    llm.contextWindows = contextMeasurements.snapshot();
    llm.generation = generationHealthSnapshot();
    // Same record as /debug's routedToBackup; null under normal routing.
    llm.routedToBackup = failoverRoutingSnapshot();

    res.json({
      t: new Date().toISOString(),
      llm,
      trackSelection: settings.get().llm?.trackSelection === 'shortlist' ? 'shortlist' : 'agentic',
      shortlist: summarizeShortlistPicks(shortlistPicks),
      tts: summarizeTts(ttsCalls),
      djLog: summarizeDjLog(queue.djLog),
      requests: summarizeRequests(recentRequests),
      transitions: transitionsOrNull(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
