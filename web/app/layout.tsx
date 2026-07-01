import './globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Fraunces, Plus_Jakarta_Sans, JetBrains_Mono } from 'next/font/google';
import { GoogleAnalytics } from '@next/third-parties/google';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import { LITE_INIT_SCRIPT } from '@/lib/lite';
import { SITE_URL } from '@/lib/site';
import ServiceWorkerRegister from '@/components/ServiceWorkerRegister';
import MotionProvider from '@/components/MotionProvider';
import ThemeBootstrap from '@/components/ThemeBootstrap';
import JsonLd from '@/components/JsonLd';

// Visitor tracking. The gtag.js script only loads when a Measurement ID is
// configured, so dev and un-instrumented deploys stay analytics-free.
const GA_ID = process.env.NEXT_PUBLIC_GA_ID;

// Fraunces — the display serif. Soft, optical-axis editorial face used for
// every headline + the masthead wordmark; opsz makes it self-tune contrast to
// the rendered size. Plus Jakarta Sans carries body/UI; JetBrains Mono is data
// (timestamps, durations, code, kbd) so numbers read like hi-fi gear.
const fraunces = Fraunces({
  subsets: ['latin'],
  axes: ['opsz'],
  display: 'swap',
  variable: '--font-display',
});

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin', 'latin-ext'],
  weight: ['300', '400', '500', '700', '800'],
  display: 'swap',
  variable: '--font-mono',
});

const DESCRIPTION =
  'A real internet radio station. Single Icecast stream — every listener hears the same broadcast at the same time, picked and announced by an LLM-driven DJ.';

const SOCIAL_TITLE = 'SUB/WAVE — A real internet radio station';
const OG_IMAGE_ALT = 'SUB/WAVE — a real internet radio station';

// Site-wide structured data. WebSite + Organization give search engines the
// canonical name/logo to attach to rich results across every page.
const SITE_JSONLD = [
  {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'SUB/WAVE',
    url: SITE_URL,
    description: DESCRIPTION,
  },
  {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'SUB/WAVE',
    url: SITE_URL,
    logo: `${SITE_URL}/icons/512`,
  },
];

// The share-card image tags (og:image, twitter:image) are emitted manually in
// <head> below — NOT via the Metadata API. Next routes every URL in the
// Metadata API through `metadataBase`, and it drops metadataBase on the
// force-dynamic homepage, pinning those URLs to a localhost origin.
// Hand-written <meta> tags are emitted verbatim, so the absolute SITE_URL
// survives. Per-page canonical + og:url go through lib/seo's pageMeta(), which
// passes absolute strings the Metadata API leaves untouched. The Metadata API
// still owns everything that isn't a fixed URL — titles, descriptions, icons,
// PWA metas.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: 'SUB/WAVE', template: '%s · SUB/WAVE' },
  description: DESCRIPTION,
  applicationName: 'SUB/WAVE',
  // iOS standalone-install + status bar styling. Android picks these up via
  // manifest.js; iOS still needs the `apple-mobile-web-app-*` metas.
  appleWebApp: {
    capable: true,
    title: 'SUB/WAVE',
    statusBarStyle: 'black-translucent',
  },
  formatDetection: { telephone: false },
  openGraph: {
    title: SOCIAL_TITLE,
    description: DESCRIPTION,
    siteName: 'SUB/WAVE',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: SOCIAL_TITLE,
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f3efe6' },
    { media: '(prefers-color-scheme: dark)',  color: '#100e0c' },
  ],
  // `cover` lets the page extend under the iPhone notch / Dynamic Island /
  // home indicator when installed. Pair with env(safe-area-inset-*) in CSS
  // for any UI close to the edges.
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${plusJakarta.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Apply stored theme before paint to avoid flash of wrong palette.
            Script body is a static constant from lib/theme — no untrusted input. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />

        {/* Resolve low-power "lite" mode (?lite=… or stored pref) before paint
            so a pinned kiosk never flashes the heavy, blur-heavy build. Static
            constant from lib/lite — no untrusted input. */}
        <script dangerouslySetInnerHTML={{ __html: LITE_INIT_SCRIPT }} />

        {/* Site-wide structured data (WebSite + Organization). */}
        <JsonLd data={SITE_JSONLD} />

        {/* Absolute share-card image tags — see the metadata comment above for
            why these bypass the Metadata API. Per-page canonical + og:url are
            set via lib/seo's pageMeta(). SITE_URL is baked at build time from
            the Docker build arg. */}
        <meta property="og:image" content={`${SITE_URL}/og`} />
        <meta property="og:image:type" content="image/png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content={OG_IMAGE_ALT} />
        <meta name="twitter:image" content={`${SITE_URL}/og`} />
        <meta name="twitter:image:alt" content={OG_IMAGE_ALT} />
      </head>
      <body suppressHydrationWarning>
        <MotionProvider>
          <ThemeBootstrap>
            <ServiceWorkerRegister />
            {children}
          </ThemeBootstrap>
        </MotionProvider>
      </body>
      {GA_ID ? <GoogleAnalytics gaId={GA_ID} /> : null}
    </html>
  );
}
