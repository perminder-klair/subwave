import type { Metadata } from 'next';
import SettingsPanel from '../../../components/admin/SettingsPanel';
import { HostedProvider } from '../../../components/admin/HostedContext';
import { hostedFromEnv } from '../../../lib/hosted';

// Resolve SUBWAVE_HOSTED at runtime, including in prebuilt Docker images.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Settings',
};

// SUBWAVE_HOSTED: run by SUB/WAVE Cloud, whose box agent manages the LLM and
// the voice engine (controller setup/hosted.ts), so those controls are hidden,
// DJ Brain among them: a hosted station is already wired to the brain.
export default function AdminSettingsPage() {
  const info = hostedFromEnv(process.env);
  return (
    <HostedProvider value={info}>
      <SettingsPanel hosted={info.hosted} />
    </HostedProvider>
  );
}
