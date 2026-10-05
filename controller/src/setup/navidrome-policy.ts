// Connection precedence shared by boot, maintenance workers and setup status.
// Multi-station profiles never inherit installation-wide music credentials.
import { envStr, envUrl } from '../util/env.js';
import { savedNavidromeCredentialsSchema } from '../schemas/onboarding.js';

export type NavidromeCredentials = Partial<ReturnType<typeof savedNavidromeCredentialsSchema.parse>>;

export function navidromeEnvLocks(allowEnv: boolean) {
  return {
    url: allowEnv && !!process.env.NAVIDROME_URL,
    user: allowEnv && !!process.env.NAVIDROME_USER,
    pass: allowEnv && !!process.env.NAVIDROME_PASS,
  };
}

export function resolveNavidrome(raw: unknown = {}, allowEnv = false) {
  const nv = savedNavidromeCredentialsSchema.parse(raw);
  const locks = navidromeEnvLocks(allowEnv);
  return {
    url: locks.url ? envUrl('NAVIDROME_URL', 'http://navidrome:4533')
      : nv.url || (allowEnv ? 'http://navidrome:4533' : ''),
    user: locks.user ? envStr('NAVIDROME_USER', '') : nv.user || '',
    password: locks.pass ? process.env.NAVIDROME_PASS! : nv.pass || '',
  };
}

export function hasNavidrome(raw: unknown): boolean {
  const nv = savedNavidromeCredentialsSchema.parse(raw);
  return Object.values(nv).every(v => v.trim() !== '');
}
