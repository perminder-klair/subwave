import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Operator-only and per-request; nothing durable to index, so keep it out of
// search results (already absent from the sitemap).
export const metadata: Metadata = {
  // `absolute` opts out of the root layout's `%s · SUB/WAVE` template; the
  // brand is already in the title.
  title: { absolute: 'SUB/WAVE — Setup' },
  robots: { index: false, follow: false },
};

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return children;
}
