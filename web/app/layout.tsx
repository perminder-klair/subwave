import './globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Fraunces, Plus_Jakarta_Sans, JetBrains_Mono, Doto, Space_Grotesk, Instrument_Serif, IBM_Plex_Mono, Space_Mono, Fira_Code, Anton, Chakra_Petch, Saira_Stencil_One, Courier_Prime, Overpass_Mono } from 'next/font/google';
import { GoogleAnalytics } from '@next/third-parties/google';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import { LITE_INIT_SCRIPT } from '@/lib/lite';
import { SKIN_INIT_SCRIPT } from '@/lib/skin';
import { SITE_URL } from '@/lib/site';
import { GA_ID } from '@/lib/ga';
import ServiceWorkerRegister from '@/components/ServiceWorkerRegister';
import MotionProvider from '@/components/MotionProvider';
import ThemeProvider from '@/components/ThemeProvider';
import JsonLd from '@/components/JsonLd';
import { Toaster } from '@/components/ui/toaster';

// gtag.js only loads when a Measurement ID is configured (lib/ga, resolved from
// the runtime env), so dev and un-instrumented deploys stay analytics-free.

// Fraunces is the display serif (its opsz axis self-tunes contrast). Plus
// Jakarta Sans carries body/UI, JetBrains Mono is data.
const fraunces = Fraunces({
  subsets: ['latin'],
  axes: ['opsz'],
  display: 'swap',
  variable: '--font-fraunces',
});

// Curated display faces a theme can select via the --display-font token (see
// lib/theme FONT_STACKS). Loaded globally; kept small to bound bundle weight.
const doto = Doto({
  subsets: ['latin'],
  weight: 'variable',
  display: 'swap',
  variable: '--font-doto',
});

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-space-grotesk',
});

const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
  variable: '--font-instrument-serif',
});

const anton = Anton({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
  variable: '--font-anton',
});

const chakraPetch = Chakra_Petch({
  subsets: ['latin'],
  weight: ['400', '700'],
  display: 'swap',
  variable: '--font-chakra-petch',
});

const sairaStencilOne = Saira_Stencil_One({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
  variable: '--font-saira-stencil-one',
});

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

// The default data face. Its next/font variable is --font-jetbrains, NOT
// --font-mono: the `font-mono` utility follows the themeable --mono-font token.
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin', 'latin-ext'],
  weight: ['300', '400', '500', '700', '800'],
  display: 'swap',
  variable: '--font-jetbrains',
});

// Curated monospace faces a theme can select via the --mono-font token.
const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-ibm-plex-mono',
});

const spaceMono = Space_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  display: 'swap',
  variable: '--font-space-mono',
});

const firaCode = Fira_Code({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-fira-code',
});

const courierPrime = Courier_Prime({
  subsets: ['latin'],
  weight: ['400', '700'],
  display: 'swap',
  variable: '--font-courier-prime',
});

const overpassMono = Overpass_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-overpass-mono',
});

const DESCRIPTION =
  'A real internet radio station. Single Icecast stream — every listener hears the same broadcast at the same time, picked and announced by an LLM-driven DJ.';

const SOCIAL_TITLE = 'SUB/WAVE — A real internet radio station';
const OG_IMAGE_ALT = 'SUB/WAVE — a real internet radio station';

// WebSite + Organization give search engines the canonical name/logo.
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

// The share-card image tags (og:image, twitter:image) are emitted by hand in
// <head> below, NOT via the Metadata API: Next routes every Metadata API URL
// through `metadataBase`, which it drops on the force-dynamic homepage, pinning
// those URLs to localhost. Hand-written <meta> tags are emitted verbatim.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: 'SUB/WAVE', template: '%s · SUB/WAVE' },
  description: DESCRIPTION,
  applicationName: 'SUB/WAVE',
  // Android picks these up via manifest.js; iOS still needs the
  // `apple-mobile-web-app-*` metas.
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
  // `cover` lets the page extend under the iPhone notch / home indicator when
  // installed. Pair with env(safe-area-inset-*) for any UI near the edges.
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${plusJakarta.variable} ${jetbrainsMono.variable} ${doto.variable} ${spaceGrotesk.variable} ${instrumentSerif.variable} ${anton.variable} ${chakraPetch.variable} ${sairaStencilOne.variable} ${ibmPlexMono.variable} ${spaceMono.variable} ${firaCode.variable} ${courierPrime.variable} ${overpassMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Apply stored theme before paint to avoid a flash of the wrong
            palette. Static constant from lib/theme, no untrusted input. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />

        {/* Resolve low-power "lite" mode before paint so a pinned kiosk never
            flashes the heavy build. Static constant from lib/lite. */}
        <script dangerouslySetInnerHTML={{ __html: LITE_INIT_SCRIPT }} />

        {/* Hide the player shell before paint when this browser resolves to a
            non-default skin. Static constant from lib/skin. */}
        <script dangerouslySetInnerHTML={{ __html: SKIN_INIT_SCRIPT }} />

        <JsonLd data={SITE_JSONLD} />

        {/* Absolute share-card image tags -- see the metadata comment above for
            why these bypass the Metadata API. */}
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
          <ThemeProvider>
            <ServiceWorkerRegister />
            {children}
            {/* Mounted once at the root so every route has somewhere for
                `notify()` to appear. Per-shell mounts duplicate the toaster. */}
            <Toaster />
          </ThemeProvider>
        </MotionProvider>
      </body>
      {GA_ID ? <GoogleAnalytics gaId={GA_ID} /> : null}
    </html>
  );
}
