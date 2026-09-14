// Device-level connectivity, subscribed once for the whole tree: neither
// useStationFeed nor useSignal can tell the UI the phone has no network.
// Prebuild auto-adds ACCESS_NETWORK_STATE on Android.
//
// `isConnected` is null until the first NetInfo reading, and callers treat only
// an explicit false as offline, so a cold start never flashes the banner.

import NetInfo, { type NetInfoStateType } from '@react-native-community/netinfo';
import { useEffect, useState } from 'react';

export interface Connectivity {
  isConnected: boolean | null;
  type: NetInfoStateType | null;
}

export function useConnectivity(): Connectivity {
  const [state, setState] = useState<Connectivity>({ isConnected: null, type: null });

  useEffect(() => {
    // addEventListener fires immediately with the latest state on most
    // platforms; the explicit fetch() guarantees a value where it doesn't.
    let alive = true;
    NetInfo.fetch()
      .then((s) => {
        if (alive) setState({ isConnected: s.isConnected, type: s.type });
      })
      .catch(() => {
        /* keep the null baseline; addEventListener still reports in */
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
