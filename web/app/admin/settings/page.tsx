import type { Metadata } from 'next';
import SettingsPanel from '../../../components/admin/SettingsPanel';

// Resolve the alpha opt-in at runtime, including in prebuilt Docker images.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Settings',
};

export default function AdminSettingsPage() {
  return <SettingsPanel djBrainEnabled={process.env.SUBWAVE_DJ_BRAIN_ENABLED === 'true'} />;
}
