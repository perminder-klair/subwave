'use client';

// Install-level effects for the full-page player routes (`/`, `/listen`) —
// concerns of *this deployment*, not of whichever station the player tree is
// tuned to, which is why they live at the page level and not inside PlayerApp:
// showcase-embedded players must never redirect the operator or fire beacons
// at the stations they preview.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { defaultStationClient } from '@/lib/stationClient';

export default function PlayerPageEffects() {
  const router = useRouter();

  // First-run redirect — if this install hasn't been configured yet (no
  // Navidrome creds), bounce the operator into the wizard instead of dropping
  // them on a silent player. Mirrors AdminShell.
  useEffect(() => {
    defaultStationClient.onboardingStatus().then(j => {
      if (j?.needsSetup) router.push('/onboarding');
    });
  }, [router]);

  // One-shot audience beacon: hand the controller the external referrer + any
  // UTM tag on first load. The referrer is browser-only knowledge — by the time
  // the API polls run, it's same-origin — so we report document.referrer here.
  // Guarded by a per-tab sessionStorage flag so refreshes/remounts don't double
  // count; the controller also dedupes by IP. Best-effort, never blocks.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (sessionStorage.getItem('sw_beacon')) return;
      sessionStorage.setItem('sw_beacon', '1');
    } catch {
      /* private mode: no storage — proceed, the server dedupes by IP */
    }
    const q = new URLSearchParams(window.location.search);
    const utmSource = q.get('utm_source') || q.get('ref') || q.get('source') || undefined;
    defaultStationClient.beacon({
      referrer: document.referrer || '',
      path: window.location.pathname,
      utmSource,
    });
  }, []);

  return null;
}
