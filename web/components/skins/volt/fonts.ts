// Doto — the VOLT/LAB display face, a dot-matrix variable font. Loaded here
// (not in app/layout) so it only ships in the Volt skin's dynamic chunk; the
// weight is driven to 900 in CSS (.doto). ROND stays at its default (square
// dots) — the classic digital-display look. JetBrains Mono for everything
// else is already global (--font-mono), reused rather than reloaded.

import { Doto } from 'next/font/google';

export const doto = Doto({
  subsets: ['latin'],
  weight: 'variable',
  display: 'swap',
  variable: '--font-volt-display',
});
