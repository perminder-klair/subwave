import { ImageResponse } from 'next/og';
import { DiscMark } from '../lib/discMark';

export const size = { width: 64, height: 64 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(<DiscMark size={size.width} />, { ...size });
}
