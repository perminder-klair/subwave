import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import DocShell from '@/components/docs/DocShell';
import { MANUAL_PAGES } from '@/components/manual/pages';

export const metadata: Metadata = {
  title: 'SUB/WAVE — Manual',
  description:
    'How to use SUB/WAVE — tuning in, making requests, how the AI DJ works, and running the station from the admin console.',
};

export default function ManualLayout({ children }: { children: ReactNode }) {
  return (
    <DocShell pages={MANUAL_PAGES} eyebrow="THE MANUAL" ariaLabel="Manual contents">
      {children}
    </DocShell>
  );
}
