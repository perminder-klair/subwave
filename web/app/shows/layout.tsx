import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Masthead from '@/components/landing/Masthead';
import StationFooter from '@/components/landing/StationFooter';

export const metadata: Metadata = {
  title: 'SUB/WAVE — Community Shows',
  description:
    'The community show catalog for SUB/WAVE — produced-show templates shared by other stations, installable from any station&rsquo;s admin console.',
};

// Shared chrome for the /shows showcase: the broadsheet masthead, the page
// body in the single full-width broadsheet column, and the station footer.
// Mirrors app/skills/layout.tsx + app/personas/layout.tsx.
export default function ShowsLayout({ children }: { children: ReactNode }) {
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
