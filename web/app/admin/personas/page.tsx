import type { Metadata } from 'next';
import PersonasPanel from '../../../components/admin/PersonasPanel';
import { HostedProvider } from '../../../components/admin/HostedContext';
import { hostedFromEnv } from '../../../lib/hosted';

// Resolve SUBWAVE_HOSTED at runtime, including in prebuilt Docker images.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Personas' };

export default function AdminPersonasPage() {
  return (
    <HostedProvider value={hostedFromEnv(process.env)}>
      <PersonasPanel />
    </HostedProvider>
  );
}
