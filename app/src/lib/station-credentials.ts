export interface StationCredentials {
  username: string;
  password: string;
}

export interface StoredStationRef {
  url: string;
  name: string;
  lastUsed?: number;
}

export interface StoredStationStore {
  activeStation: string | null;
  recents: StoredStationRef[];
}

/** Strip a trailing slash; default to https:// if the user typed a bare host. */
export function normalizeStationBase(raw: string): string {
  let value = (raw || '').trim();
  if (!value) return value;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  return value.replace(/\/+$/, '');
}

function decodeUserinfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Separate legacy URL userinfo from the public station address. */
export function splitStationAddress(raw: string): {
  base: string;
  credentials: StationCredentials | null;
} {
  const normalized = normalizeStationBase(raw);
  const match = normalized.match(/^(https?:\/\/)(?:([^/@]+)@)?(.+)$/i);
  if (!match || !match[2]) return { base: normalized, credentials: null };

  const [, scheme, userinfo, rest] = match;
  const separator = userinfo.indexOf(':');
  return {
    base: `${scheme}${rest}`,
    credentials: {
      username: decodeUserinfo(separator >= 0 ? userinfo.slice(0, separator) : userinfo),
      password: decodeUserinfo(separator >= 0 ? userinfo.slice(separator + 1) : ''),
    },
  };
}

// Standard base64 over UTF-8 bytes. Hermes' global btoa is version-dependent
// and latin1-only, so credentials need a small self-contained encoder.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(input: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i);
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const low = input.charCodeAt(++i);
      code = 0x10000 + ((code & 0x3ff) << 10) + (low & 0x3ff);
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }

  let encoded = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    encoded += B64[b0 >> 2];
    encoded += B64[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    encoded += b1 === undefined ? '=' : B64[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    encoded += b2 === undefined ? '=' : B64[b2 & 63];
  }
  return encoded;
}

export function authorizationFor(credentials: StationCredentials): string {
  return `Basic ${base64(`${credentials.username}:${credentials.password}`)}`;
}

/** Reconstruct the proven URL-userinfo request path in memory only. */
export function credentialedBase(base: string, credentials: StationCredentials | null): string {
  const cleanBase = splitStationAddress(base).base;
  if (!credentials) return cleanBase;
  const match = cleanBase.match(/^(https?:\/\/)(.+)$/i);
  if (!match) return cleanBase;
  const [, scheme, rest] = match;
  return `${scheme}${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@${rest}`;
}

export function resolveStationConnection(
  rawBase: string,
  suppliedCredentials?: StationCredentials | null,
): { base: string; requestBase: string; authorization: string | null } {
  const split = splitStationAddress(rawBase);
  const credentials = suppliedCredentials === undefined
    ? split.credentials
    : suppliedCredentials;
  return {
    base: split.base,
    requestBase: credentialedBase(split.base, credentials),
    authorization: credentials ? authorizationFor(credentials) : null,
  };
}

/** Probe a bare public station over TLS first. Authenticated probes never
 * silently downgrade to cleartext; listeners must type http:// explicitly. */
export function stationProbeCandidates(raw: string, authenticated: boolean): string[] {
  const trimmed = raw.trim();
  const split = splitStationAddress(trimmed);
  if (!split.base) return [];
  if (/:\/\//.test(trimmed)) return [split.base];
  const bareBase = split.base.replace(/^https?:\/\//i, '');
  return authenticated
    ? [`https://${bareBase}`]
    : [`https://${bareBase}`, `http://${bareBase}`];
}

/** Remove userinfo from legacy AsyncStorage records and return secrets for
 * migration into platform-secure storage. */
export function migrateLegacyStationStore(store: StoredStationStore): {
  store: StoredStationStore;
  credentials: Record<string, StationCredentials>;
  changed: boolean;
} {
  const credentials: Record<string, StationCredentials> = {};
  let changed = false;

  const splitAndMark = (raw: string) => {
    const split = splitStationAddress(raw);
    if (split.base !== raw) changed = true;
    if (split.credentials) changed = true;
    return split;
  };

  const splitRecents = store.recents.map((recent) => ({
    recent,
    split: splitAndMark(recent.url),
  }));
  // Recents are newest-first. Walk oldest-to-newest so the latest login wins.
  for (let i = splitRecents.length - 1; i >= 0; i--) {
    const { split } = splitRecents[i];
    if (split.credentials) credentials[split.base] = split.credentials;
  }

  const active = store.activeStation ? splitAndMark(store.activeStation) : null;
  // The active URL is the most authoritative legacy record.
  if (active?.credentials) credentials[active.base] = active.credentials;

  const activeStation = active?.base ?? null;
  const recents = splitRecents.map(({ recent, split }) => {
    return split.base === recent.url ? recent : { ...recent, url: split.base };
  });

  return {
    store: changed ? { activeStation, recents } : store,
    credentials,
    changed,
  };
}
