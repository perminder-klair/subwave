import type { ReactNode } from 'react';
import Masthead from '@/components/landing/Masthead';
import StationFooter from '@/components/landing/StationFooter';
import DocNav, { type DocNavProps } from './DocNav';

// Shared chrome for the /setup/* and /manual/* doc pages: the broadsheet
// masthead, a sticky sidebar table of contents, the page body, and the station
// footer. Wired up once per section in app/{setup,manual}/layout.tsx so each
// page component is just its content.
export default function DocShell({
  pages,
  eyebrow,
  ariaLabel,
  children,
}: DocNavProps & { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <Masthead />

      <main className="bs-paper">
        <div className="bs-manual-layout">
          <DocNav pages={pages} eyebrow={eyebrow} ariaLabel={ariaLabel} />
          <div className="bs-manual-content">{children}</div>
        </div>
        <StationFooter />
      </main>
    </div>
  );
}
