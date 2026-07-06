import Masthead from './landing/Masthead';
import StationFooter from './landing/StationFooter';
import ArticleHead from './what/ArticleHead';
import OnTheAir from './what/OnTheAir';
import MeetTheVoices from './what/MeetTheVoices';
import YourStack from './what/YourStack';
import MakeARequest from './what/MakeARequest';
import BehindTheDesk from './what/BehindTheDesk';
import UnderTheHood from './what/UnderTheHood';
import Navidrome from './landing/Navidrome';
import Coda from './what/Coda';
import type { ShowcaseStation } from '@/lib/stations';

// The public landing page. A newsprint-broadsheet article introducing
// SUB/WAVE — the listener player (a live embedded mount), the AI DJ, song
// requests, the admin console, the architecture, and the music-library
// integration. Section components live under `what/` and `landing/`.
// `stations` (from the content/stations directory, resolved server-side)
// feeds the showcase's station tabs; omit and the demo pins to this station.
export default function Landing({ stations = [] }: { stations?: ShowcaseStation[] }) {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <a
        href="#landing-main"
        className="sr-only z-50 bg-bg px-4 py-2 text-[12px] font-bold tracking-[0.18em] text-ink uppercase focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:border focus:border-ink"
      >
        Skip to content
      </a>
      <Masthead />

      <main id="landing-main" className="bs-paper pt-0">
        <ArticleHead />
        <OnTheAir stations={stations} />
        <MeetTheVoices />
        <YourStack />
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
