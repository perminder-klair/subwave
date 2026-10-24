import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Alexa playback tokens are bearer credentials, so keep their lifetime short
 * and bind them to one exact Icecast mount. The station password is used only
 * as the signing secret; it is never placed in the token or returned to Alexa.
 */
export const DEFAULT_ALEXA_TOKEN_TTL_HOURS = 24;
export const ALEXA_TOKEN_TTL_HOURS = { min: 1, max: 168 } as const;

type AlexaTokenPayload = {
  v: 1;
  mount: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

const TOKEN_PREFIX = 'alexa1';

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signature(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

function safeSignatureEqual(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Create a token accepted by the Icecast URL-auth callback. */
export function createAlexaStreamToken(
  secret: string,
  mount: string,
  ttlSeconds: number,
  now = Date.now(),
): string {
  if (!secret || !mount || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return '';
  const issuedAt = Math.floor(now / 1000);
  const payload: AlexaTokenPayload = {
    v: 1,
    mount,
    issuedAt,
    expiresAt: issuedAt + Math.floor(ttlSeconds),
    nonce: randomBytes(12).toString('base64url'),
  };
  const encodedPayload = encode(JSON.stringify(payload));
  const signed = `${TOKEN_PREFIX}.${encodedPayload}`;
  return `${signed}.${signature(signed, secret)}`;
}

/** Verify a token without revealing why a candidate failed. */
export function verifyAlexaStreamToken(
  token: string,
  secret: string,
  expectedMount: string,
  now = Date.now(),
): boolean {
  if (!token || !secret || !expectedMount) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return false;

  const signed = `${parts[0]}.${parts[1]}`;
  if (!safeSignatureEqual(parts[2], signature(signed, secret))) return false;

  try {
    const payload = JSON.parse(decode(parts[1])) as Partial<AlexaTokenPayload>;
    const nowSeconds = Math.floor(now / 1000);
    return payload.v === 1
      && payload.mount === expectedMount
      && typeof payload.issuedAt === 'number'
      && typeof payload.expiresAt === 'number'
      && Number.isInteger(payload.issuedAt)
      && Number.isInteger(payload.expiresAt)
      && payload.issuedAt <= nowSeconds + 60
      && payload.expiresAt > nowSeconds
      && payload.expiresAt > payload.issuedAt
      && typeof payload.nonce === 'string'
      && payload.nonce.length >= 8;
  } catch {
    return false;
  }
}
