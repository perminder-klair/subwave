import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import tseslint from 'typescript-eslint';
import betterTailwindcss from 'eslint-plugin-better-tailwindcss';
import reactPlugin from 'eslint-plugin-react';

// Routes that compile through Satori (`next/og` ImageResponse). Satori only
// resolves inline JSX `style={…}` — Tailwind class strings are dropped —
// so these files are exempt from no-inline-style and Tailwind class rules.
// (Scoped to .ts/.tsx because the strict rules below only apply there.)
const OG_ROUTE_FILES = [
  'app/og/**/*.{ts,tsx}',
  'app/icon.{ts,tsx}',
  'app/apple-icon.{ts,tsx}',
  'app/icons/**/*.{ts,tsx}',
  'app/screenshots/**/*.{ts,tsx}',
];

export default defineConfig([
  ...nextVitals,
  ...tseslint.configs.recommended,
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'node_modules/**',
    'next-env.d.ts',
    'public/sw.js',
  ]),

  // Strict styling rules — scoped to TypeScript files only so PR1 lands with
  // zero behaviour change on the existing .js/.jsx surface. Each file rename
  // .jsx → .tsx in PR3+ immediately pulls that file under the strict rules,
  // which is the forcing function for finishing the Tailwind migration.
  //
  // eslint-plugin-better-tailwindcss is v4-aware: it reads the `@theme` block
  // in app/globals.css (via `entryPoint`) to know which class names resolve.
  // `no-unknown-classes` is the v4 equivalent of "no-custom-classname" and
  // enforces "no hardcoded colours/spacings in JSX" from issue #50.
  {
    files: ['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}'],
    plugins: {
      'better-tailwindcss': betterTailwindcss,
    },
    settings: {
      'better-tailwindcss': {
        entryPoint: 'app/globals.css',
      },
    },
    rules: {
      'better-tailwindcss/no-unknown-classes': [
        'error',
        {
          // .v3-*, .bs-* (broadsheet) and .admin-* are component classes
          // defined in app/globals.css that haven't been promoted to
          // @theme/@layer yet. The Track-2 migration deletes them; until
          // then, ignored so file renames don't trip on legacy CSS.
          //
          // The trailing bare names (eyebrow, card, metric, …) are admin-
          // scoped descendant selectors under `.admin-root .X` in globals.css.
          // Same legacy-CSS deal as the prefixes above, just unprefixed for
          // historical reasons. Listed explicitly to keep the lint strict
          // outside this allow-list.
          ignore: [
            '^v3-',
            // .fz-* — the console-deck footer's hardware-part classes
            // (TransportBar), defined in app/globals.css. Same legacy-CSS deal
            // as the other prefixes: component CSS not yet promoted to @theme.
            '^fz-',
            '^bs-',
            '^broadsheet-',
            '^admin-',
            '^sw-',
            '^player-',
            // .lib-* — redesigned /admin/library component classes in
            // app/globals.css (.admin-root .lib-*). Same legacy-CSS deal.
            '^lib-',
            // .hs-* — the /admin/dash StationHeader status strip instruments
            // (.admin-root .hs-*), ported from a Claude Design prototype.
            // Bespoke gauge/bar/lamp CSS in app/globals.css.
            '^hs-',
            // admin-scoped descendant classes from globals.css
            '^eyebrow$',
            '^caption$',
            '^mono-num$',
            '^card$',
            '^card-head$',
            '^card-body$',
            '^title$',
            '^sub$',
            '^right$',
            '^metric$',
            '^wave$',
            '^kv$',
            '^k$',
            '^field$',
            '^field-hint$',
            '^rule-label$',
            '^term$',
            '^log$',
            '^msg$',
            '^t$',
            '^idx$',
            '^dur$',
            '^artist$',
            '^track-row$',
            '^live-dot$',
            '^shell-header$',
            '^shell-body$',
            '^shell-nav$',
            '^sign-out$',
            '^wordmark$',
            '^crumb$',
            '^nav-section$',
            '^nav-section-label$',
            '^nav-item$',
            '^nav-icon$',
            '^nav-label$',
            '^nav-foot$',
            '^pill$',
            '^paper$',
            '^danger$',
            '^muted$',
            '^loose$',
            '^tight$',
            '^stack-mobile$',
            '^n$',
            '^l$',
            '^accent$',
            '^active$',
            '^strip-mobile$',
            // bare state / descendant classes used with .lib-* parents
            '^on$',
            '^box$',
            '^flash$',
            '^indet$',
            '^pct$',
            '^h-tags$',
            '^h-album$',
          ],
        },
      ],
      'better-tailwindcss/enforce-consistent-class-order': 'error',
      'better-tailwindcss/no-duplicate-classes': 'error',
      'better-tailwindcss/no-conflicting-classes': 'error',
    },
  },

  // No inline styles in TS sources — Tailwind utilities only. Issue #50.
  {
    files: ['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}'],
    plugins: { react: reactPlugin },
    rules: {
      'react/forbid-dom-props': [
        'error',
        {
          forbid: [
            {
              propName: 'style',
              message:
                'Inline styles are forbidden — use Tailwind utilities or `cn()` (see issue #50). next/og routes are exempt via override.',
            },
          ],
        },
      ],
    },
  },

  // Exemptions for next/og ImageResponse routes — Satori needs inline styles
  // and can't resolve Tailwind classes, so disable the relevant rules here.
  {
    files: OG_ROUTE_FILES,
    rules: {
      'react/forbid-dom-props': 'off',
      'better-tailwindcss/no-unknown-classes': 'off',
      'better-tailwindcss/enforce-consistent-class-order': 'off',
      'better-tailwindcss/no-duplicate-classes': 'off',
      'better-tailwindcss/no-conflicting-classes': 'off',
    },
  },

  // Exemptions for the Library Observatory — a full-bleed data-art view ported
  // from a Claude Design prototype (web/app/observatory + components/
  // observatory). Its styling is intrinsically dynamic: SVG node positions,
  // data-driven bar widths, the ink→vermilion heat ramp and per-cell embedding
  // opacities are computed at runtime and can't be expressed as static Tailwind
  // utilities. Its bespoke component classes (obs-*, cmap-*, dossier-*, …) live
  // in app/globals.css under `.observatory-root`, same legacy-CSS deal as the
  // bs-*/admin-*/lib-* surfaces in the allow-list above. Same exemption shape
  // as the next/og routes.
  {
    files: ['app/observatory/**/*.{ts,tsx}', 'components/observatory/**/*.{ts,tsx}'],
    rules: {
      'react/forbid-dom-props': 'off',
      'better-tailwindcss/no-unknown-classes': 'off',
      'better-tailwindcss/enforce-consistent-class-order': 'off',
      'better-tailwindcss/no-duplicate-classes': 'off',
      'better-tailwindcss/no-conflicting-classes': 'off',
    },
  },

  {
    rules: {
      // Prose noise — JSX renders apostrophes/quotes fine.
      'react/no-unescaped-entities': 'off',
      // Two simple <img> sites (cover proxy, screenshot helper). next/image
      // would need explicit dimensions + images.remotePatterns config for the
      // controller proxy — not worth it at this scale.
      '@next/next/no-img-element': 'off',
      // Standard Tailwind config pattern (export default object literal).
      'import/no-anonymous-default-export': [
        'error',
        {
          allowObject: true,
          allowArray: true,
        },
      ],
      // React 19 lints below flag the canonical SSR-safe hydration pattern
      // (read localStorage / matchMedia / Date.now on mount, then setState).
      // Moving these to useState(init) breaks SSR; useSyncExternalStore is
      // overkill for one-shot init. Leaving off project-wide.
      'react-hooks/set-state-in-effect': 'off',
      // useKeyboardShortcuts mutates handlersRef.current during render so the
      // window listener binds once and survives PlayerApp's per-second
      // re-renders (see hook header comment). Moving into useEffect creates a
      // stale-on-first-render window.
      'react-hooks/refs': 'off',
      // typescript-eslint defaults — relaxed for the JS-majority transition
      // window. PR3+ will rename .js→.ts and these get tightened.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
]);
