import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import StationsShell from '@/components/stations/StationsShell';

export const metadata: Metadata = {
  title: 'SUB/WAVE — Stations',
  description:
    'A directory of SUB/WAVE stations around the world. See who is on the air right now, and add your own.',
};

export default function StationsLayout({ children }: { children: ReactNode }) {
  return <StationsShell>{children}</StationsShell>;
}
