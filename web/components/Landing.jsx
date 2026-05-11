'use client';

import { useEffect, useState } from 'react';
import { Toaster } from './ui/toaster';
import Masthead from './landing/Masthead';
import Hero from './landing/Hero';
import WhatIs from './landing/WhatIs';
import Navidrome from './landing/Navidrome';
import MeetTheDJ from './landing/MeetTheDJ';
import BoothColumn from './landing/BoothColumn';
import HowWeBroadcast from './landing/HowWeBroadcast';
import RecentPlays from './landing/RecentPlays';
import RequestSection from './landing/RequestSection';
import StationFooter from './landing/StationFooter';
import { useStationFeed } from '../hooks/useStationFeed';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

// Public marketing landing. The actual V3 player lives inside Hero's
// PlayerShowcase as a contained mount — it's the same React tree, so audio
// and state are real, just framed in a browser-window mock. The sections
// below explain what SUB/WAVE is, who's DJing, and how the broadcast works.
export default function Landing() {
  const { state, dj } = useStationFeed();
  const [persona, setPersona] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/dj`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setPersona(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const djInfo = persona || dj || null;
  const location = persona?.location || '';

  return (
    <div style={{ background: 'var(--bg)', color: 'var(--ink)', minHeight: '100vh' }}>
      <Masthead djName={djInfo?.name} location={location} />

      <main className="bs-paper">
        <Hero djName={djInfo?.name} />

        <WhatIs />

        <Navidrome />

        <MeetTheDJ />

        <section className="bs-section">
          <HowWeBroadcast />
        </section>

        <section className="bs-section">
          <BoothColumn items={state.djLog} />
        </section>

        <section className="bs-section">
          <div className="bs-grid-split">
            <div>
              <RecentPlays items={state.history} />
            </div>
            <div className="bs-column-rule" aria-hidden="true" />
            <div>
              <RequestSection />
            </div>
          </div>
        </section>

        <StationFooter djName={djInfo?.name} />
      </main>

      <Toaster />
    </div>
  );
}
