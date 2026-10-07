# Web dependency updates

Use stable releases and preserve peer compatibility. Next.js, its third-party
integrations, and its ESLint config should move together. The controller and web
must declare and resolve the same Zod version because they share form schemas.

The October 2026 update retains these compatibility limits:

| Package | Limit | Reason |
| --- | --- | --- |
| ESLint | 9.39.5 | `eslint-plugin-react` does not support ESLint 10. Next's lint config also depends on that plugin. |
| TypeScript | 6.0.3 | `typescript-eslint` requires TypeScript below 6.1. The web's query audit also uses the TypeScript compiler API. |
| Node types | 24.x | The standalone web image runs Node 24. |
| js-yaml | 4.3.2 | Gray Matter binds the legacy `safeLoad` and `safeDump` exports during import. Version 4 retains those exports; the news loader explicitly uses the supported `load` API. |

The package overrides patch nested dependencies whose callers have not updated
their declared ranges:

- Gray Matter uses the direct js-yaml dependency, removing its old parser and
  the vulnerable `sprintf-js` dependency. The news tests render every committed
  dispatch and check unquoted dates and Markdown tables.
- ANSI to React uses Linkify It 6.1. Terminal text, ANSI colors, and clickable
  URLs were checked with React's server renderer.
- The math and diagram renderers use KaTeX 0.19. Equation rendering was checked
  through its real `renderToString` API.

`svg-dotted-map` was renamed to `piri`. The station map now uses that maintained
package and retains its existing marker metadata. Piri's land boundary calculation
produces 3,447 dots at the configured density, compared with the old package's
3,454 dots.

After this update, `npm audit --omit=dev` reports no vulnerabilities. The full
audit reports five high-severity entries from one unpatched `braces` dependency
in Next's ESLint tooling. npm proposes downgrading `eslint-config-next` to 14 to
avoid it; keep the lint config aligned with Next 16 and recheck upstream releases
instead. The advisory is [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).

Run `npm run lint`, `npm test`, and `npm run build` after dependency changes.
For Zod changes, run the controller's checks and regenerate the schema mirror too.
