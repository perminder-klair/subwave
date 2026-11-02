// Replaces hand-written settings.json cold loads. Import lazily so tests can
// set env first; config.STATE_DIR selects the active station, not just the root.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function coldLoadSettings(stored: object) {
  const { STATE_DIR } = await import('../../src/config.js');
  const settings = await import('../../src/settings.js');
  const { setCache } = await import('../../src/settings/store.js');
  writeFileSync(join(STATE_DIR, 'settings.json'), JSON.stringify(stored));
  setCache(null);
  await settings.load();
  return settings.get();
}
