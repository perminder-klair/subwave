import type { ReactNode } from 'react';
import Masthead from '@/components/landing/Masthead';
import StationFooter from '@/components/landing/StationFooter';

// Shared chrome for every /news page: the broadsheet masthead, the page body
// in a single full-width column (the wire is a front page, not a TOC), and the
// station footer. Wired up once in app/news/layout.tsx so each page component
// is just its content.
export default function NewsShell({ children }: { children: ReactNode }) {
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
