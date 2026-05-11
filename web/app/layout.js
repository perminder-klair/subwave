import './globals.css';
import { JetBrains_Mono } from 'next/font/google';
import { THEME_INIT_SCRIPT } from '../lib/theme';

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin', 'latin-ext'],
  weight: ['300', '400', '500', '700', '800'],
  display: 'swap',
  variable: '--font-mono',
});

export const metadata = {
  title: { default: 'SUB/WAVE', template: '%s · SUB/WAVE' },
  description:
    'A real internet radio station. Single Icecast stream — every listener hears the same broadcast at the same time, picked and announced by an LLM-driven DJ.',
  openGraph: {
    title: 'SUB/WAVE',
    description: 'Personal radio frequency from the homelab.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'SUB/WAVE',
    description: 'Personal radio frequency from the homelab.',
  },
};

export const viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f3efe6' },
    { media: '(prefers-color-scheme: dark)',  color: '#100e0c' },
  ],
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={jetbrainsMono.variable} suppressHydrationWarning>
      <head>
        {/* Apply stored theme before paint to avoid flash of wrong palette.
            Script body is a static constant from lib/theme — no untrusted input. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
