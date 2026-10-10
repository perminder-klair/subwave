import express from 'express';
import { requireAdmin } from '../../middleware/auth.js';
import * as library from '../../music/library.js';
import * as sceneVocab from '../../music/scene-vocab.js';
import { sceneReferences } from '../../music/scene-references.js';
import { queue } from '../../broadcast/queue.js';
import { validateBody } from '../../middleware/validate.js';
import { sceneMergeSchema } from '../../schemas/library.js';
import type { z } from 'zod';

type SceneMergeBody = z.output<ReturnType<typeof sceneMergeSchema>>;
export const router = express.Router();

// Scene vocabulary (#1577): the genre tag set as one curatable list. Counts
// come from the mirror, not Navidrome's genre index, so every value listed is
// one a merge can reach. A full json_each walk of `tracks`, so never polled.

const SCENE_REFERENCES_LOGGED = 5;

function sceneListing() {
  return { scenes: library.scenes(), aliases: sceneVocab.list() };
}

router.get('/library/scenes', requireAdmin, async (_req, res) => {
  try {
    await library.load();
    res.json(sceneListing());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The referenced-by warning (#1593), asked BEFORE the merge. Same body and
// same call as the merge, so preview and merge cannot disagree.
router.post(
  '/library/scenes/references',
  requireAdmin,
  validateBody(sceneMergeSchema(), { messages: 'verbatim' }),
  async (req, res) => {
    const { from, to } = req.body as SceneMergeBody;
    try {
      res.json({ references: await sceneReferences(from, to) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

router.post(
  '/library/scenes/merge',
  requireAdmin,
  validateBody(sceneMergeSchema(), { messages: 'verbatim' }),
  async (req, res) => {
    const { from, to } = req.body as SceneMergeBody;
    try {
      await library.load();
      // Computed BEFORE the rewrite: the target resolves through the rule set this
      // merge is about to change.
      const references = await sceneReferences(from, to);
      const result = await library.consolidateScenes(from, to);
      // Three outcomes: rows rewritten; no rows but a rule recorded; nothing to do
      // (a 200 with zero counts, which must not claim a rule was recorded).
      queue.log(
        'info',
        result.tracksChanged > 0
          ? `scenes: merged ${result.sources.map(s => `"${s}"`).join(', ')} → "${result.target}" (${result.tracksChanged} track${result.tracksChanged === 1 ? '' : 's'})`
          : result.recorded.length > 0
            ? `scenes: nothing to rewrite for "${result.target}" — rule recorded for the next library scan`
            : `scenes: nothing to do — "${result.target}" already survives every value picked`,
      );
      // Named, not counted, so the log still explains a show that airs nothing.
      if (references.length) {
        const named = references
          .slice(0, SCENE_REFERENCES_LOGGED)
          .map(r => `${r.kind} "${r.name}" (${r.orphaned.map(v => `"${v}"`).join(', ')})`);
        const rest = references.length - named.length;
        queue.log(
          'warn',
          `scenes: merging into "${result.target}" retires values still filtered by ${named.join(', ')}${rest > 0 ? ` and ${rest} more` : ''} — repoint them by hand`,
        );
      }
      res.json({
        ok: true,
        target: result.target,
        sources: result.sources,
        recorded: result.recorded,
        tracksChanged: result.tracksChanged,
        vectorsDirtied: result.vectorsDirtied,
        // Filters that named a retired value and now match nothing. A warning, never
        // a block.
        references,
        ...sceneListing(),
      });
    } catch (err) {
      queue.log('error', `/library/scenes/merge failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  },
);

// Forgetting a rule stops it applying to FUTURE walks; rows it already rewrote
// keep the merged value and cannot be restored. The UI says this on the button.
router.delete('/library/scenes/aliases/:from', requireAdmin, async (req, res) => {
  try {
    const removed = await sceneVocab.forget(req.params.from);
    if (!removed) return res.status(404).json({ error: 'no such scene rule' });
    queue.log('info', `scenes: dropped the rule for "${req.params.from}"`);
    // Aliases only: no row is rewritten, so the client's counts are still
    // correct and a rescan would be a full table walk for an unchanged answer.
    res.json({ ok: true, aliases: sceneVocab.list() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
