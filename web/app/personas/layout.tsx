import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Masthead from '@/components/landing/Masthead';
import StationFooter from '@/components/landing/StationFooter';

export const metadata: Metadata = {
  title: 'SUB/WAVE — Community Personas',
  description:
    'The community persona catalog for SUB/WAVE — DJ identities shared by other stations, installable from any station&rsquo;s admin console.',
};

// Shared chrome for the /personas showcase: the broadsheet masthead, the page
// body in the single full-width broadsheet column, and the station footer.
// Mirrors app/skills/layout.tsx.
export default function PersonasLayout({ children }: { children: ReactNode }) {
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
