import Masthead from './landing/Masthead';
import StationFooter from './landing/StationFooter';
import ArticleHead from './what/ArticleHead';
import OnTheAir from './what/OnTheAir';
import MeetTheVoices from './what/MeetTheVoices';
import MakeARequest from './what/MakeARequest';
import BehindTheDesk from './what/BehindTheDesk';
import UnderTheHood from './what/UnderTheHood';
import Navidrome from './landing/Navidrome';
import Coda from './what/Coda';

// The public landing page. A newsprint-broadsheet article introducing
// SUB/WAVE — the listener player (a live embedded mount), the AI DJ, song
// requests, the admin console, the architecture, and the music-library
// integration. Section components live under `what/` and `landing/`.
export default function Landing() {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <Masthead />

      <main className="bs-paper pt-0">
        <ArticleHead />
        <OnTheAir />
        <MeetTheVoices />
        <MakeARequest />
        <BehindTheDesk />
        <UnderTheHood />
        <Navidrome />
        <Coda />
        <StationFooter />
      </main>
    </div>
  );
}
