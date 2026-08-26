import type { StationCredentials } from './station-credentials';

const STORAGE_KEY = 'subwave.stationCredentials.v1';

export interface CredentialStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
}

export interface CredentialVault {
  get(base: string): Promise<StationCredentials | null>;
  set(base: string, credentials: StationCredentials): Promise<void>;
  remove(base: string): Promise<void>;
  merge(credentials: Record<string, StationCredentials>): Promise<void>;
}

function isCredentials(value: unknown): value is StationCredentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<StationCredentials>;
  return typeof candidate.username === 'string' && typeof candidate.password === 'string';
}

export function createCredentialVault(storage: CredentialStorage): CredentialVault {
  const read = async (): Promise<Record<string, StationCredentials>> => {
    try {
      const raw = await storage.getItemAsync(STORAGE_KEY);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, StationCredentials] =>
          isCredentials(entry[1]),
        ),
      );
    } catch {
      return {};
    }
  };

  const write = (values: Record<string, StationCredentials>) =>
    storage.setItemAsync(STORAGE_KEY, JSON.stringify(values));

  return {
    async get(base) {
      const values = await read();
      return values[base] ?? null;
    },
    async set(base, credentials) {
      const values = await read();
      values[base] = credentials;
      await write(values);
    },
    async remove(base) {
      const values = await read();
      if (!(base in values)) return;
      delete values[base];
      await write(values);
    },
    async merge(credentials) {
      if (!Object.keys(credentials).length) return;
      const values = await read();
      await write({ ...values, ...credentials });
    },
  };
}
