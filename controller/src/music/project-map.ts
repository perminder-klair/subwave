// Standalone sound-map projection pass (see music/map-projection.ts).
//
// Run:  docker exec sub-wave-controller npx tsx src/music/project-map.ts
//
// Spawned as a child by the live controller (map-projection.ts startProjection)
// because UMAP's KNN-graph build is minutes of synchronous CPU — running it
// in-process would freeze every listener poll. Opens its own DB connection,
// exactly like the tagger/analyzer children.

import * as db from './library-db.js';
import { resolveEmbeddingDim } from './embeddings.js';
import { runProjection } from './map-projection.js';

async function main() {
  await db.open({ embeddingDim: resolveEmbeddingDim(), adoptStoredDim: true });
  const { count, ms } = await runProjection();
  console.log(`done: ${count} tracks projected in ${Math.round(ms / 1000)}s`);
  db.close();
}

main().catch((err) => {
  console.error('projection failed:', err.message);
  process.exit(1);
});
