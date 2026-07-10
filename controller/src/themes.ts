// Theme registry — built-in palettes baked into the controller image, plus
// optional user JSONs from ${STATE_DIR}/themes/. The web shell writes the
// active theme's tokens onto <html> as inline CSS variables (web/lib/theme.ts);
// the values here are whatever you'd write directly into a CSS custom property.
//
// Adding a new themable token: extend THEME_TOKEN_KEYS *and* declare a
// fallback for it in :root in web/app/globals.css. Themes that omit the new
// key inherit the fallback. Themes that mention keys outside this allowlist
// have those keys silently dropped — operators can't inject arbitrary CSS via
// a theme file.
import { promises as fs, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { config } from './config.js';

export const THEME_TOKEN_KEYS = [
  '--bg',
  '--ink',
  '--muted',
  '--accent',
  '--overlay',
  '--soft-border',
  '--field',
] as const;

const TOKEN_KEY_SET = new Set<string>(THEME_TOKEN_KEYS);

// Reject anything that could break out of the inline CSS variable assignment
// once the browser writes it onto document.documentElement.style. A stray ";"
// would close the property and let the rest of the value declare arbitrary
// styles; "{}" / "<>" guard against tag-shaped payloads. 100-char cap covers
// every realistic token value (the longest builtin is a color-mix() call).
const TOKEN_VAL_RE = /^[^;{}<>]{1,100}$/;

const TokenMapSchema = z.record(z.string(), z.string()).transform((rec, ctx) => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (!TOKEN_KEY_SET.has(k)) continue; // silently drop unknown keys
    if (!TOKEN_VAL_RE.test(v)) {
      ctx.addIssue({ code: 'custom', message: `token ${k} has unsafe value` });
      continue;
    }
    out[k] = v;
  }
  return out;
});

const ThemeSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  name: z.string().min(1).max(60),
  description: z.string().max(200).optional().default(''),
  mode: z.enum(['light', 'dark']),
  tokens: TokenMapSchema,
});

export type Theme = z.infer<typeof ThemeSchema>;

// ---------------------------------------------------------------------------
// Built-ins — loaded synchronously at module load.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = join(HERE, 'themes', 'builtin');

function loadBuiltins(): Theme[] {
  const themes: Theme[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(BUILTIN_DIR).filter(f => f.endsWith('.json')).sort();
  } catch {
    console.warn(`[themes] no built-in themes at ${BUILTIN_DIR}`);
    return themes;
  }
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(BUILTIN_DIR, file), 'utf8'));
      themes.push(ThemeSchema.parse(raw));
    } catch (err) {
      console.warn(`[themes] skipping malformed built-in ${file}: ${(err as Error).message}`);
    }
  }
  return themes;
}

export const BUILTIN_THEMES: Theme[] = loadBuiltins();
const BUILTIN_IDS = new Set(BUILTIN_THEMES.map(t => t.id));

export const DEFAULT_THEME_ID =
  BUILTIN_THEMES.find(t => t.id === 'classic-light')?.id
  ?? BUILTIN_THEMES[0]?.id
  ?? 'classic-light';

// Seeded into state/themes/README.md on first read so operators editing the
// folder directly have the format reference at hand.
export const USER_THEMES_README = `# Custom themes

Drop \`.json\` files in this directory to add themes to the SUB/WAVE picker.

Each file:

\`\`\`json
{
  "id": "my-theme",
  "name": "My Theme",
  "description": "Optional short blurb",
  "mode": "dark",
  "tokens": {
    "--bg": "#000000",
    "--ink": "#ffffff",
    "--accent": "#ff6b3d"
  }
}
\`\`\`

Allowed token keys: ${THEME_TOKEN_KEYS.join(', ')}.

\`id\` should match the filename (\`my-theme.json\` → \`id: "my-theme"\`) and may
only contain lowercase letters, digits, and dashes. Built-in ids
(${[...BUILTIN_IDS].join(', ')}) are reserved — files claiming those ids are skipped.

Tokens you omit inherit from the mode baseline (light or dark) declared in
\`web/app/globals.css\`. After dropping a new file in, use the **Refresh themes**
button in admin → Settings → Theme to make it appear in the picker without a
controller restart.
`;

// ---------------------------------------------------------------------------
// User themes — read from ${STATE_DIR}/themes/.
// ---------------------------------------------------------------------------

function userThemesDir(): string {
  return join(config.stateDir, 'themes');
}

let userCache: { themes: Theme[]; loadedAt: number } | null = null;
const USER_CACHE_TTL_MS = 30_000;

export async function loadUserThemes(force = false): Promise<Theme[]> {
  if (!force && userCache && Date.now() - userCache.loadedAt < USER_CACHE_TTL_MS) {
    return userCache.themes;
  }
  const dir = userThemesDir();
  try {
    await fs.mkdir(dir, { recursive: true });
    const readmePath = join(dir, 'README.md');
    try {
      await fs.access(readmePath);
    } catch {
      try { await fs.writeFile(readmePath, USER_THEMES_README, 'utf8'); } catch {}
    }
  } catch {
    // Best-effort — if we can't create the dir we just have no user themes.
  }

  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter(f => f.endsWith('.json')).sort();
  } catch {
    userCache = { themes: [], loadedAt: Date.now() };
    return [];
  }

  const themes: Theme[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(await fs.readFile(join(dir, file), 'utf8'));
      const parsed = ThemeSchema.parse(raw);
      if (BUILTIN_IDS.has(parsed.id)) {
        console.warn(`[themes] user theme ${file} uses reserved built-in id "${parsed.id}" — skipped`);
        continue;
      }
      const expected = `${parsed.id}.json`;
      if (file !== expected) {
        console.warn(`[themes] user theme ${file} declares id "${parsed.id}" — filename mismatch`);
      }
      themes.push(parsed);
    } catch (err) {
      console.warn(`[themes] skipping malformed ${file}: ${(err as Error).message}`);
    }
  }
  userCache = { themes, loadedAt: Date.now() };
  return themes;
}

export function clearUserThemeCache(): void {
  userCache = null;
}

export async function listThemes(): Promise<Theme[]> {
  const user = await loadUserThemes();
  return [...BUILTIN_THEMES, ...user];
}

export type ThemeListItem = Theme & { builtin: boolean };

// Same registry as listThemes(), but each entry is tagged with whether it's a
// built-in. The admin UI uses the flag to gate the per-theme Remove button so
// only user themes (state/themes/*.json) can be deleted.
export async function listThemesAnnotated(): Promise<ThemeListItem[]> {
  return (await listThemes()).map(t => ({ ...t, builtin: BUILTIN_IDS.has(t.id) }));
}

export async function getTheme(id: string): Promise<Theme> {
  const all = await listThemes();
  return (
    all.find(t => t.id === id)
    ?? all.find(t => t.id === DEFAULT_THEME_ID)
    ?? all[0]!
  );
}

export async function isValidThemeId(id: string): Promise<boolean> {
  const all = await listThemes();
  return all.some(t => t.id === id);
}

// Turn a human name into a valid theme id (lowercase, dash-separated, ≤32
// chars, leading alphanumeric) so the create form can derive one when the
// operator doesn't supply it. Falls back to "theme" if nothing survives.
export function slugifyThemeId(name: string): string {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return /^[a-z0-9]/.test(slug) ? slug : `t-${slug}`.slice(0, 32) || 'theme';
}

// Persist an operator-created theme as ${STATE_DIR}/themes/<id>.json, the same
// shape the file-drop convention uses. Validates with the shared ThemeSchema
// (so the token security regex applies), refuses reserved built-in ids, then
// refreshes the user cache and returns the full registry.
export async function saveUserTheme(input: any): Promise<ThemeListItem[]> {
  const id = (typeof input?.id === 'string' && input.id.trim())
    ? slugifyThemeId(input.id)
    : slugifyThemeId(input?.name || '');
  const theme = ThemeSchema.parse({ ...input, id });
  if (BUILTIN_IDS.has(theme.id)) {
    throw new Error(`"${theme.id}" is a reserved built-in theme id — pick another name`);
  }
  const dir = userThemesDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, `${theme.id}.json`), JSON.stringify(theme, null, 2), 'utf8');
  clearUserThemeCache();
  await loadUserThemes(true);
  return listThemesAnnotated();
}

// Delete a user theme file (${STATE_DIR}/themes/<id>.json) and return the
// refreshed registry. Built-in ids are reserved (baked into the image, nothing
// on disk to remove). The id is regex-validated before it touches the path so a
// crafted ":id" can't traverse out of the themes dir.
export async function deleteUserTheme(id: string): Promise<ThemeListItem[]> {
  const clean = String(id || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(clean)) {
    throw new Error('invalid theme id');
  }
  if (BUILTIN_IDS.has(clean)) {
    throw new Error(`"${clean}" is a built-in theme and can't be removed`);
  }
  const file = join(userThemesDir(), `${clean}.json`);
  try {
    await fs.unlink(file);
  } catch (err: any) {
    if (err?.code === 'ENOENT') throw new Error(`no custom theme "${clean}"`);
    throw err;
  }
  clearUserThemeCache();
  await loadUserThemes(true);
  return listThemesAnnotated();
}
