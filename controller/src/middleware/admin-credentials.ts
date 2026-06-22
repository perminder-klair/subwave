import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { STATE_DIR } from '../config.js';

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keyLen: number;
  maxmem: number;
}

export interface AdminCredentials {
  user: string;
  hash: string;
  salt: string;
  scryptParams: ScryptParams;
  changedAt: string;
}

// N=2^17 with r=8 needs ~128 MiB. Node's default maxmem is 32 MiB, which
// causes ERR_CRYPTO_INVALID_SCRYPT_PARAMS. Set maxmem to 256 MiB.
export const SCRYPT_PARAMS: ScryptParams = {
  N: 131072, r: 8, p: 1, keyLen: 64, maxmem: 256 * 1024 * 1024,
};
export const MIN_PASSWORD_LENGTH = 12;

const HASH_PATH = `${STATE_DIR}/admin-hash.json`;

export function loadCredentials(): AdminCredentials | null {
  if (!existsSync(HASH_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(HASH_PATH, 'utf8'));
    // Back-compat: files written before maxmem was stored still work --
    // verifyPassword reads params from the file and falls back to the default.
    if (raw.scryptParams && raw.scryptParams.maxmem == null) {
      raw.scryptParams.maxmem = SCRYPT_PARAMS.maxmem;
    }
    return raw;
  } catch {
    return null;
  }
}

export async function saveCredentials(user: string, hash: string, salt: string): Promise<void> {
  const data: AdminCredentials = {
    user,
    hash,
    salt,
    scryptParams: SCRYPT_PARAMS,
    changedAt: new Date().toISOString(),
  };
  const tmp = `${HASH_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  chmodSync(tmp, 0o600);
  renameSync(tmp, HASH_PATH);
}

export function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16).toString('hex');
    scrypt(password, salt, SCRYPT_PARAMS.keyLen, {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      maxmem: SCRYPT_PARAMS.maxmem,
    }, (err, derived) => {
      if (err) return reject(err);
      resolve({ hash: derived.toString('hex'), salt });
    });
  });
}

export function verifyPassword(
  password: string,
  storedHash: string,
  storedSalt: string,
  params: ScryptParams,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    scrypt(password, storedSalt, params.keyLen, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: params.maxmem ?? SCRYPT_PARAMS.maxmem,
    }, (err, derived) => {
      if (err) return reject(err);
      const a = Buffer.from(derived.toString('hex'));
      const b = Buffer.from(storedHash);
      if (a.length !== b.length) {
        timingSafeEqual(a, a);
        resolve(false);
        return;
      }
      resolve(timingSafeEqual(a, b));
    });
  });
}
