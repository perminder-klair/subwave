import type { ReactNode } from 'react';
import Masthead from '@/components/landing/Masthead';
import StationFooter from '@/components/landing/StationFooter';

// Shared chrome for the /stations directory: the broadsheet masthead, the page
// body in the single full-width broadsheet column, and the station footer.
// Wired up once in app/stations/layout.tsx so the page component is just its
// content. Mirrors components/news/NewsShell.tsx.
export default function StationsShell({ children }: { children: ReactNode }) {
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
