import { ImageResponse } from 'next/og';
import { DiscMark } from '../../../lib/discMark';

// Renders the SUB/WAVE disc mark at any size, with an optional maskable
// variant that respects the Android 80% safe zone (smaller disc + larger
// dark padding so it fills the adaptive icon mask without clipping).
// Routes (all served as PNG):
//   /icons/192            — manifest standard 192
//   /icons/512            — manifest standard 512
//   /icons/192-maskable   — Android adaptive 192
//   /icons/512-maskable   — Android adaptive 512

export const contentType = 'image/png';
export const dynamic = 'force-static';

const VARIANTS = {
  '192': { size: 192, maskable: false },
  '512': { size: 512, maskable: false },
  '192-maskable': { size: 192, maskable: true },
  '512-maskable': { size: 512, maskable: true },
};

export function generateStaticParams() {
  return Object.keys(VARIANTS).map((size) => ({ size }));
}

export async function GET(_req, { params }) {
  const { size: slug } = await params;
  const variant = VARIANTS[slug];
  if (!variant) return new Response('Not Found', { status: 404 });

  const { size, maskable } = variant;
  // Standard icons fill most of the canvas; maskable shrinks the disc to
  // ~58% so it stays inside the launcher's safe zone after the mask.
  const fill = maskable ? 0.58 : 0.8;

  return new ImageResponse(<DiscMark size={size} fill={fill} />, {
    width: size,
    height: size,
  });
}
