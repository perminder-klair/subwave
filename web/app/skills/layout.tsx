import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Masthead from '@/components/landing/Masthead';
import StationFooter from '@/components/landing/StationFooter';

export const metadata: Metadata = {
  title: 'SUB/WAVE — Community Skills',
  description:
    'The community skill catalog for SUB/WAVE — prompt-only DJ segments shared by other stations, installable from any station&rsquo;s admin console.',
};

// Shared chrome for the /skills showcase: the broadsheet masthead, the page
// body in the single full-width broadsheet column, and the station footer.
// Mirrors app/stations/layout.tsx (via StationsShell) but inlined here since
// the skills page is the only route under it.
export default function SkillsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <Masthead />
      <main className="bs-paper">
        {children}
        <StationFooter />
      </main>
    </div>
  );
}
