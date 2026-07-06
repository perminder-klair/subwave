import { ImageResponse } from 'next/og';
import { DiscMark } from '../lib/discMark';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(<DiscMark size={size.width} />, { ...size });
}
