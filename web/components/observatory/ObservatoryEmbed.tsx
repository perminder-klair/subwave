'use client';

import dynamic from 'next/dynamic';

// Client boundary so the interactive, client-only constellation
// (requestAnimationFrame, window, pointer gestures) can be loaded with
// ssr:false from the otherwise-server DJ section. All the weight sits behind
// this lazy boundary, keeping the landing page's initial payload light. Lives
// under components/observatory alongside the showcase it loads (and shares the
// obs-* lint exemption).
const ObservatoryShowcase = dynamic(() => import('./ObservatoryShowcase'), {
  ssr: false,
  loading: () => (
    <div className="obs-embed-box grid place-items-center">
      <span className="bs-eyebrow text-muted">mapping the library…</span>
    </div>
  ),
});

export default function ObservatoryEmbed() {
  return <ObservatoryShowcase />;
}
