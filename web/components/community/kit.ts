// Small pure helpers shared by the public community pages (/community, /skills,
// /personas, /shows). Everything here is deterministic: the pages are server
// components, so a drawing seeded from a slug renders the same on every request
// and never needs client JS.

/** FNV-1a over the string. Stable across runtimes, good enough to pick variants. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The nth independent pick in [0, n) from one seed. */
export function pick(seed: number, salt: number, n: number): number {
  return hashString(`${seed}:${salt}`) % n;
}

/** Two-digit catalogue number: "01", "02"… */
export function lotNo(i: number): string {
  return String(i + 1).padStart(2, '0');
}

/** "45m" / "2h" / "1d" / "90" (minutes) → minutes, or null when unreadable. */
export function cooldownMinutes(raw?: string): number | null {
  if (!raw) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(m|min|mins|h|hr|hrs|d|day|days)?\s*$/i.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || 'm').toLowerCase();
  if (unit.startsWith('d')) return n * 1440;
  if (unit.startsWith('h')) return n * 60;
  return n;
}

/** The most a cooldown lets a skill air in one day. */
export function maxPerDay(minutes: number | null): number | null {
  if (!minutes) return null;
  return Math.max(1, Math.floor(1440 / minutes));
}

/** A GitHub-ish handle with any leading @ dropped, or null. */
export function handle(raw?: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const h = raw.trim().replace(/^@/, '');
  return h ? h : null;
}

/** A handle safe to put in a github.com/<handle> URL. */
export function isGithubHandle(h: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(h);
}

/** "2026-09-01" → "1 Sep 2026", or the raw string when it doesn't parse. */
export function prettyDate(iso?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Today's index into a list of `n`, so a "featured" slot rotates daily. */
export function dailyIndex(n: number, now = new Date()): number {
  if (n <= 0) return 0;
  const day = Math.floor(now.getTime() / 86400000);
  return hashString(`day:${day}`) % n;
}
