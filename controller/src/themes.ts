// Theme registry — built-in palettes baked into the controller image, plus
// optional user JSONs from ${STATE_DIR}/themes/. The web shell writes the
// active theme's tokens onto <html> as inline CSS variables (web/lib/theme.ts);
// the values here are whatever you'd write directly into a CSS custom property.
//
// Adding a new themable token: add a descriptor in ./theme-tokens.ts *and*
// declare a fallback for it in :root in web/app/globals.css. Themes that omit
// the new key inherit the fallback. Themes that mention keys outside the
// registry have those keys silently dropped, and per-token values are validated
// by type — operators can't inject arbitrary CSS via a theme file.
import { promises as fs, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { config } from './config.js';
import { THEME_TOKEN_KEYS, tokenType, isValidTokenValue } from './theme-tokens.js';

// Re-exported so existing importers (e.g. the AI theme-fill prompt in
// llm/internal/prompts/generate.ts) keep resolving it from this module.
export { THEME_TOKEN_KEYS };

const TokenMapSchema = z.record(z.string(), z.string()).transform((rec, ctx) => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (tokenType(k) === undefined) continue; // silently drop unknown keys
    if (!isValidTokenValue(k, v)) {
      ctx.addIssue({ code: 'custom', message: `token ${k} has an unsafe or out-of-range value` });
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

**Background image.** Upload one from the admin theme editor (*background
image* field), or drop a jpg/jpeg/png/webp/gif into this same folder and point
\`--bg-image\` at it:

\`\`\`json
"--bg-image": "url(\\"/theme-assets/skyline.jpg\\")"
\`\`\`

An \`https://\` URL works too: \`"url(\\"https://example.com/bg.jpg\\")"\`. Leaving
it unset (or \`"none"\`) paints no image — the player falls back to the flat
\`--bg\` colour. The image sits under the player's own panels and under the
paper-grain texture, so turn \`--grain\` down for a crisper picture.

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

// ---------------------------------------------------------------------------
// Theme assets — background images for the `--bg-image` token, stored next to
// the theme JSONs in the same folder (so a hand-dropped file and an admin
// upload land in one place, and multi-station mode keeps them per station).
// Served publicly by routes/public.ts at /theme-assets/<name>; written and
// listed by the admin routes in routes/settings/station.ts.
// ---------------------------------------------------------------------------

export function themeAssetsDir(): string {
  return userThemesDir();
}

// Leading alphanumeric, no path separators, no dotfiles. `..` is refused
// separately so "a..b.png" can't be read as a traversal attempt either.
export const THEME_ASSET_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;

export const THEME_ASSET_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// Background photos are bigger than a 512px avatar; 8 MB covers a sharp
// full-HD JPEG/WebP without inviting multi-megapixel originals.
export const THEME_ASSET_MAX_BYTES = 8 * 1024 * 1024;

// The mime a served asset name maps to, or null when the name is not an
// allowed asset (bad characters, traversal, unknown extension).
export function themeAssetMime(name: string): string | null {
  const file = String(name || '');
  if (file.includes('..') || !THEME_ASSET_NAME_RE.test(file)) return null;
  const dot = file.lastIndexOf('.');
  if (dot < 1) return null;
  return THEME_ASSET_MIME[file.slice(dot).toLowerCase()] ?? null;
}

// The browser-supplied type and extension are easy to fake, so the decoded
// bytes decide what was uploaded.
export function sniffThemeImage(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length < 12) return null;
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return { mime: 'image/png', ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return { mime: 'image/webp', ext: 'webp' };
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { mime: 'image/gif', ext: 'gif' };
  }
  return null;
}

// Turn an uploaded file's original name into a safe asset name with the
// SNIFFED extension: "My Skyline (2).JPEG" → "my-skyline-2.jpg".
export function themeAssetName(originalName: string, ext: string): string {
  const base = String(originalName || '')
    .replace(/\.[^.]*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return `${base || 'background'}.${ext}`;
}

export interface ThemeAsset {
  name: string;
  size: number;
  mtime: string;
}

export async function listThemeAssets(): Promise<ThemeAsset[]> {
  const dir = themeAssetsDir();
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: ThemeAsset[] = [];
  for (const name of names.sort()) {
    if (!themeAssetMime(name)) continue;
    try {
      const st = await fs.stat(join(dir, name));
      if (!st.isFile()) continue;
      out.push({ name, size: st.size, mtime: new Date(st.mtimeMs).toISOString() });
    } catch {
      // Vanished between readdir and stat — skip it.
    }
  }
  return out;
}

// Write an uploaded background image. Same name replaces the file (the public
// route's ETag is keyed on mtime, so listeners pick the new one up).
export async function saveThemeAsset(originalName: string, buf: Buffer): Promise<ThemeAsset> {
  if (!buf?.length) throw new Error('the uploaded file is empty');
  if (buf.length > THEME_ASSET_MAX_BYTES) {
    throw new Error(`image too large (max ${Math.round(THEME_ASSET_MAX_BYTES / (1024 * 1024))} MB)`);
  }
  const sniffed = sniffThemeImage(buf);
  if (!sniffed) throw new Error('not a JPEG, PNG, WebP or GIF image');
  const name = themeAssetName(originalName, sniffed.ext);
  const dir = themeAssetsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, name), buf);
  const st = await fs.stat(join(dir, name));
  return { name, size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
}

// Remove an uploaded image. Themes still pointing at it fall back to the flat
// --bg colour (the public route answers 404).
export async function deleteThemeAsset(name: string): Promise<void> {
  if (!themeAssetMime(name)) throw new Error('invalid image name');
  try {
    await fs.unlink(join(themeAssetsDir(), name));
  } catch (err: any) {
    if (err?.code === 'ENOENT') throw new Error(`no image "${name}"`);
    throw err;
  }
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

/** Registry after an import's file replacements, without bootstrapping or changing the cache. */
export async function themeIdsAfterImport(imported: ReadonlyMap<string, string>): Promise<Set<string>> {
  const dir = userThemesDir();
  const files = new Map<string, string>();
  for (const file of await fs.readdir(dir).catch(() => [])) {
    if (!file.endsWith('.json')) continue;
    const source = await fs.readFile(join(dir, file), 'utf8').catch(() => null);
    if (source !== null) files.set(file, source);
  }
  for (const [file, source] of imported) files.set(file, source);
  const ids = new Set(BUILTIN_IDS);
  for (const source of files.values()) {
    try {
      const parsed = ThemeSchema.safeParse(JSON.parse(source));
      if (parsed.success && !BUILTIN_IDS.has(parsed.data.id)) ids.add(parsed.data.id);
    } catch {
      // Malformed user files are skipped by the live registry too.
    }
  }
  return ids;
}

export type ThemeListItem = Theme & { builtin: boolean };

// Same registry as listThemes(), but each entry is tagged with whether it's a
// built-in. The admin UI uses the flag to gate the per-theme Remove button so
// only user themes (state/themes/*.json) can be deleted.
export async function listThemesAnnotated(): Promise<ThemeListItem[]> {
  return (await listThemes()).map(t => ({ ...t, builtin: BUILTIN_IDS.has(t.id) }));
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
