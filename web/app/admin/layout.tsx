import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import AdminShell from '../../components/admin/AdminShell';

export const metadata: Metadata = {
  title: 'Admin',
  // The auth gate is client-side, so the shell HTML is served regardless —
  // keep the console out of search indexes entirely.
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: { children: ReactNode }) {
  // Read the sidebar collapse state server-side so the rail renders in the
  // right state on first paint (no hydration flash). The Sidebar component
  // writes this cookie whenever the operator toggles it.
  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get('sidebar_state')?.value !== 'false';
  return <AdminShell defaultOpen={defaultOpen}>{children}</AdminShell>;
}
