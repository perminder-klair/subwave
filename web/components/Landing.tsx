import Masthead from './landing/Masthead';
import StationFooter from './landing/StationFooter';
import ArticleHead from './what/ArticleHead';
import OnTheAir from './what/OnTheAir';
import PressRun from './what/PressRun';
import MeetTheVoices from './what/MeetTheVoices';
import YourStack from './what/YourStack';
import MakeARequest from './what/MakeARequest';
import BehindTheDesk from './what/BehindTheDesk';
import UnderTheHood from './what/UnderTheHood';
import Navidrome from './landing/Navidrome';
import Coda from './what/Coda';
import type { ShowcaseStation } from '@/lib/stations';

export default function Landing({ stations = [] }: { stations?: ShowcaseStation[] }) {
  return (
    <div className="min-h-screen overflow-x-clip bg-bg text-ink">
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
        <PressRun />
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
