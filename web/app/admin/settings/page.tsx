import type { Metadata } from 'next';
import SettingsPanel from '../../../components/admin/SettingsPanel';
import { HostedProvider, hostedFromEnv } from '../../../components/admin/HostedContext';

// Resolve the alpha opt-in at runtime, including in prebuilt Docker images.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Settings',
};

// SUBWAVE_HOSTED: run by SUB/WAVE Cloud, whose box agent manages the LLM and
// the voice engine (controller setup/hosted.ts), so those controls are hidden.
export default function AdminSettingsPage() {
  const info = hostedFromEnv(process.env);
  return (
    <HostedProvider value={info}>
      <SettingsPanel
        djBrainEnabled={!info.hosted && process.env.SUBWAVE_DJ_BRAIN_ENABLED === 'true'}
        hosted={info.hosted}
      />
    </HostedProvider>
  );
}
