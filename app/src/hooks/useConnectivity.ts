// Device-level connectivity signal, backed by @react-native-community/netinfo.
//
// useStationFeed swallows fetch errors (a failed poll just retries on the next
// tick), and useSignal only probes /health while tuned in — so neither can tell
// the UI "the phone has no network." This thin wrapper subscribes to the OS
// reachability state once for the whole tree and exposes it for the connection
// banner (and usePlayer's proactive reconnect). No config plugin is needed;
// prebuild auto-adds ACCESS_NETWORK_STATE on Android.
//
// `isConnected` is `null` until the first NetInfo reading lands — callers treat
// only an explicit `false` as "offline" so a cold start never flashes the
// banner before the radio reports in.

import NetInfo, { type NetInfoStateType } from '@react-native-community/netinfo';
import { useEffect, useState } from 'react';

export interface Connectivity {
  isConnected: boolean | null;
  type: NetInfoStateType | null;
}

export function useConnectivity(): Connectivity {
  const [state, setState] = useState<Connectivity>({ isConnected: null, type: null });

  useEffect(() => {
    // Seed from the current reading, then track changes. addEventListener fires
    // immediately with the latest state on most platforms, but the explicit
    // fetch() guarantees a value even if it doesn't.
    let alive = true;
    NetInfo.fetch()
      .then((s) => {
        if (alive) setState({ isConnected: s.isConnected, type: s.type });
      })
      .catch(() => {
        /* keep the null baseline — addEventListener will still report in */
      });
    const unsub = NetInfo.addEventListener((s) => {
      setState({ isConnected: s.isConnected, type: s.type });
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  return state;
}
