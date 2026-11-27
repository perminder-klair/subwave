import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import AppsShell from '@/components/apps/AppsShell';

export const metadata: Metadata = {
  title: 'SUB/WAVE — Plugins',
  description:
    'Music-source plugins for SUB/WAVE: play your station from a server or library it does not support out of the box.',
};

// The same broadsheet frame as /apps (AppsShell is only the masthead + footer).
export default function PluginsLayout({ children }: { children: ReactNode }) {
  return <AppsShell>{children}</AppsShell>;
}
