// Android Auto. The car's station list is native (modules/android-auto), and
// it can only connect once the player's media session exists, which needs the
// player set up. When the car connects, including when it launched the app
// with no screen, the browse service runs this task to do that. Picking a
// station or asking for one by voice then arrives in service.ts.

import { AppRegistry, Platform } from 'react-native';
import { setupPlayer } from '@/audio/player';

// Matched by STRING with modules/android-auto/…/CarConnectTask.kt.
const CAR_CONNECT_TASK = 'SubwaveCarConnect';

/** Call once, early, outside the React tree: the car can start the app with
 *  no screen to mount. */
export function registerCarHandlers(): void {
  if (Platform.OS !== 'android') return;
  // Sets up only. Nothing plays until the listener picks a station.
  AppRegistry.registerHeadlessTask(CAR_CONNECT_TASK, () => () => setupPlayer());
}
