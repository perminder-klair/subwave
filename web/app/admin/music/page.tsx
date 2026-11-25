import type { Metadata } from 'next';
import RouterPanel from '../../../components/admin/router/RouterPanel';
import { HostedProvider } from '../../../components/admin/HostedContext';
import { hostedFromEnv } from '../../../lib/hosted';

// Resolve SUBWAVE_HOSTED at runtime, including in prebuilt Docker images.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Music source',
};

// Hosted (SUB/WAVE Cloud runs the library): the Source tab shows the upload
// links instead of a choice.
export default function AdminMusicPage() {
  return (
    <HostedProvider value={hostedFromEnv(process.env)}>
      <RouterPanel />
    </HostedProvider>
  );
}
