import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// The first-run wizard is operator-only and renders different content per
// request depending on setup state — there is nothing durable to index, so
// keep it out of search results (it is already absent from the sitemap).
export const metadata: Metadata = {
  title: 'SUB/WAVE — Setup',
  robots: { index: false, follow: false },
};

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
