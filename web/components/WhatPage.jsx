import Masthead from './landing/Masthead';
import StationFooter from './landing/StationFooter';
import ArticleHead from './what/ArticleHead';
import OnTheAir from './what/OnTheAir';
import MeetTheVoices from './what/MeetTheVoices';
import MakeARequest from './what/MakeARequest';
import BehindTheDesk from './what/BehindTheDesk';
import UnderTheHood from './what/UnderTheHood';
import Coda from './what/Coda';

// Feature-story page at /what. A newsprint-broadsheet article introducing
// SUB/WAVE — the listener player, the AI DJ, song requests, the admin console,
// and the architecture. Screenshot slots render placeholders until real images
// are dropped in via the Figure component's `src` prop.
export default function WhatPage() {
  return (
    <div style={{ background: 'var(--bg)', color: 'var(--ink)', minHeight: '100vh' }}>
      <Masthead />

      <main className="bs-paper">
        <ArticleHead />
        <OnTheAir />
        <MeetTheVoices />
        <MakeARequest />
        <BehindTheDesk />
        <UnderTheHood />
        <Coda />
        <StationFooter />
      </main>
    </div>
  );
}
