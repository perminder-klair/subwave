import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Admin-gated data view — keep it out of search indexes like the admin shell.
export const metadata: Metadata = {
  title: 'Library Observatory',
  robots: { index: false, follow: false },
};

export default function ObservatoryLayout({ children }: { children: ReactNode }) {
  return children;
}
