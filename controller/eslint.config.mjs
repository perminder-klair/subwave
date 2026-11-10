import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  ...tseslint.configs.recommended,
  globalIgnores([
    'node_modules/**',
    'scripts/*',
    '!scripts/*.test.ts',
    '!scripts/run-tests.ts',
    '!scripts/test-utils/',
  ]),
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Files under src/schemas/ are mirrored verbatim into the web bundle by
    // scripts/gen-schemas.ts, so they must not reach for anything the browser
    // cannot resolve. *-server.ts is the escape hatch and is NOT mirrored.
    files: ['src/schemas/*.ts'],
    ignores: ['src/schemas/*-server.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Deny-everything-then-allow-one, because this ESLint version's
              // no-restricted-imports schema has no top-level "allow" key —
              // passing one is a config validation error, not a no-op. What it
              // does have is "group", matched gitignore-style by the `ignore`
              // package, where a leading "!" re-includes a previously excluded
              // path. So "*" restricts every specifier and "!zod" carves the one
              // exception back out. Verified to catch bare packages, node:
              // builtins and relative paths alike; gen-schemas.ts enforces the
              // same rule a second time, at generate time.
              group: ['*', '!zod'],
              message:
                'src/schemas/* is mirrored into the browser — import only from "zod". Put anything else in a *-server.ts sibling.',
            },
          ],
        },
      ],
    },
  },
]);
