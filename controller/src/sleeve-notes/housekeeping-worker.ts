import { close, open } from './db.js';
import { expireRecycleBin } from './moderation.js';
import { pruneCompletedWikipediaArticlesInDatabase } from './wikipedia-retention.js';
import * as settings from '../settings.js';

process.on('message', async () => {
  let error: string | undefined;
  try {
    await settings.load();
    if (!settings.get().djBehaviour.extendedSleeveNotes) return;
    expireRecycleBin();
    pruneCompletedWikipediaArticlesInDatabase(open());
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    try {
      close();
    } catch (cause) {
      error ??= cause instanceof Error ? cause.message : String(cause);
    }
    if (process.send) process.send({ error }, () => process.disconnect());
    else process.disconnect();
  }
});
