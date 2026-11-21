import Link from 'next/link';

export type GeniusCaptureState = { enabled: boolean; configured: boolean };

export default function GeniusCaptureNotice({ state }: { state?: GeniusCaptureState }) {
  if (!state || state.enabled && state.configured) return null;
  return <div className="border border-border p-3 text-[13px] leading-relaxed">
    <p>{state.enabled
      ? 'Genius capture needs an API key. Add one to collect sample, cover and contributor connections.'
      : 'Genius capture is off. New sample, cover and contributor connections are not being collected.'}</p>
    <p className="mt-1 text-muted">You can still browse your library and Wikipedia stories. Previously saved connections remain visible as saved research.</p>
    <Link href="/admin/notes?tab=config" className="mt-2 inline-block text-primary hover:underline">Open Notes Settings →</Link>
  </div>;
}
