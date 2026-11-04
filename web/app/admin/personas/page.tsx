import type { Metadata } from 'next';
import PersonasPanel from '../../../components/admin/PersonasPanel';
import { HostedProvider, hostedFromEnv } from '../../../components/admin/HostedContext';

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
