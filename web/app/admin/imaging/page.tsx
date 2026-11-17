import type { Metadata } from 'next';
import ImagingPanel from '../../../components/admin/imaging/ImagingPanel';
import { HostedProvider } from '../../../components/admin/HostedContext';
import { hostedFromEnv } from '../../../lib/hosted';

// Resolve SUBWAVE_HOSTED at runtime, including in prebuilt Docker images.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Imaging',
};

// Hosted: the jingle voice picker offers only the engines the box runs, as the
// persona one does (EngineVoiceFields reads the context).
export default function AdminImagingPage() {
  return (
    <HostedProvider value={hostedFromEnv(process.env)}>
      <ImagingPanel />
    </HostedProvider>
  );
}
