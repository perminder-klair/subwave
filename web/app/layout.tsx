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

// Visitor tracking. The gtag.js script only loads when a Measurement ID is
// configured (see lib/ga — resolved from the runtime env so it works without a
// rebuild), so dev and un-instrumented deploys stay analytics-free.

// Fraunces — the display serif. Soft, optical-axis editorial face used for
// every headline + the masthead wordmark; opsz makes it self-tune contrast to
// the rendered size. Plus Jakarta Sans carries body/UI; JetBrains Mono is data
// (timestamps, durations, code, kbd) so numbers read like hi-fi gear.
const fraunces = Fraunces({
  subsets: ['latin'],
  axes: ['opsz'],
  display: 'swap',
  variable: '--font-fraunces',
});

// Curated display faces a theme can select via the --display-font token (see
// lib/theme FONT_STACKS + the theme-token registry). Loaded globally so the
// operator-picked headline face applies across every skin + the admin console.
// Kept small to bound bundle weight; latin subset, display: swap.
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

// JetBrains is the default data face. Its next/font variable is --font-jetbrains
// now (not --font-mono), because the `font-mono` utility follows the themeable
// --mono-font token (globals.css @theme), which defaults to JetBrains.
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin', 'latin-ext'],
  weight: ['300', '400', '500', '700', '800'],
  display: 'swap',
  variable: '--font-jetbrains',
});

// Curated monospace faces a theme can select via the --mono-font token — reaches
// the mono-forward skins (Subamp, TTY) and everything using `font-mono`.
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
      className={`${fraunces.variable} ${plusJakarta.variable} ${jetbrainsMono.variable} ${doto.variable} ${spaceGrotesk.variable} ${instrumentSerif.variable} ${anton.variable} ${chakraPetch.variable} ${sairaStencilOne.variable} ${ibmPlexMono.variable} ${spaceMono.variable} ${firaCode.variable} ${courierPrime.variable} ${overpassMono.variable}`}
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

        {/* Hide the player shell before paint when this browser resolves to a
            non-default skin, so a reload never flashes the wrong face. Static
            constant from lib/skin — no untrusted input. */}
        <script dangerouslySetInnerHTML={{ __html: SKIN_INIT_SCRIPT }} />

        {/* Site-wide structured data (WebSite + Organization). */}
        <JsonLd data={SITE_JSONLD} />

        {/* Absolute share-card image tags — see the metadata comment above for
            why these bypass the Metadata API. Per-page canonical + og:url are
            set via lib/seo's pageMeta(). SITE_URL is resolved from the runtime
            container env — the public pages render per-request (see
            lib/site.ts), so these tags always carry the operator's domain. */}
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
            {/* App-shell transient-feedback channel. Mounted once at the root so
                every route (onboarding, observatory, landing, admin, player) has
                somewhere for `notify()` (lib/notify → Sonner) to appear; the
                per-shell mounts were removed to avoid a duplicate toaster. */}
            <Toaster />
          </ThemeProvider>
        </MotionProvider>
      </body>
      {GA_ID ? <GoogleAnalytics gaId={GA_ID} /> : null}
    </html>
  );
}
