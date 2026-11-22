import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Masthead from '@/components/landing/Masthead';
import StationFooter from '@/components/landing/StationFooter';

export const metadata: Metadata = {
  title: 'SUB/WAVE — Community',
  description:
    'Everything SUB/WAVE operators have built and shared: skills, personas, shows, apps and stations.',
};

// Shared chrome for the /community hub: masthead, full-width broadsheet
// column, station footer.
export default function CommunityLayout({ children }: { children: ReactNode }) {
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
