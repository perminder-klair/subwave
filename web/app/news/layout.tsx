import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import NewsShell from '@/components/news/NewsShell';

export const metadata: Metadata = {
  title: 'SUB/WAVE — Dispatches',
  description:
    'News and updates from the SUB/WAVE desk — new features, fixes, and short how-tos for running your own AI radio station.',
};

export default function NewsLayout({ children }: { children: ReactNode }) {
  return <NewsShell>{children}</NewsShell>;
}
