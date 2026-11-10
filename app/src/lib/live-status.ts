import { createApi, type StationApi } from './api';
import type { StationCredentials } from './station-credentials';

/** The client a station list's live dot probes with: the station's saved
 *  Station login, sent the way the player sends it (loginHeaders, #2119), so
 *  a proxy that guards /api answers. A keychain that cannot be read probes
 *  with no login, as the dot did before. The dot only reads /now-playing:
 *  a refused login shows offline, never the login-rejected flow, and it
 *  never asks /station-auth. */
export async function liveStatusClient(
  url: string,
  savedLogin: (url: string) => Promise<StationCredentials | null>,
): Promise<StationApi> {
  const login = await savedLogin(url).catch(() => undefined);
  return createApi(url, login);
}
