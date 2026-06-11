/** @type {import('tailwindcss').Config} */
// Colors resolve to CSS variables so the station theme (fetched from /themes)
// can override them at runtime via NativeWind's `vars()` applied at the root
// (see ThemeProvider). Defaults live in global.css. Mirrors the 7 theme tokens
// the web player uses (lib/theme.ts THEME_TOKEN_KEYS).
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        ink: 'var(--ink)',
        muted: 'var(--muted)',
        accent: 'var(--accent)',
        vermilion: 'var(--accent)',
        overlay: 'var(--overlay)',
        field: 'var(--field)',
        'separator-soft': 'var(--soft-border)',
        'separator-strong': 'var(--soft-border)',
      },
      fontFamily: {
        display: ['Fraunces_600SemiBold'],
        'display-light': ['Fraunces_400Regular'],
        body: ['PlusJakartaSans_400Regular'],
        'body-medium': ['PlusJakartaSans_500Medium'],
        'body-semibold': ['PlusJakartaSans_600SemiBold'],
        mono: ['JetBrainsMono_400Regular'],
        'mono-medium': ['JetBrainsMono_500Medium'],
      },
      letterSpacing: {
        eyebrow: '3px',
      },
    },
  },
  plugins: [],
};
