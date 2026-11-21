import * as settings from '../settings.js';

/** Settings is the operator-managed source; the environment fallback keeps
 * existing development installs working while they move the token in Config. */
export function geniusAccessToken(): string {
  return settings.get().sleeveNotes.providers.genius.accessToken
    || process.env.GENIUS_ACCESS_TOKEN
    || '';
}
