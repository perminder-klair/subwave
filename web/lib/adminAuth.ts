'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';
const STORAGE_KEY = 'subwave_admin_auth';

export interface SignInResult {
  ok: boolean;
  error?: string;
}

export interface AdminAuth {
  auth: string | null;
  needsAuth: boolean;
  hydrated: boolean;
  signIn: (user: string, pass: string) => Promise<SignInResult>;
  signOut: () => void;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

interface AuthSnapshot {
  auth: string | null;
  needsAuth: boolean;
  hydrated: boolean;
}

const SERVER_SNAPSHOT: AuthSnapshot = { auth: null, needsAuth: false, hydrated: false };
let authSnapshot: AuthSnapshot = SERVER_SNAPSHOT;
// True only when the snapshot's non-null token is known to have been read
// from or successfully written to localStorage. If storage is unavailable,
// the in-memory snapshot remains a deliberate session-only fallback.
let authSnapshotPersisted = false;
let browserStoreStarted = false;
const authListeners = new Set<() => void>();

function publishAuth(next: AuthSnapshot): void {
  if (
    next.auth === authSnapshot.auth
    && next.needsAuth === authSnapshot.needsAuth
    && next.hydrated === authSnapshot.hydrated
  ) return;
  authSnapshot = next;
  for (const listener of authListeners) listener();
}

type StoredAuth = { available: true; auth: string | null } | { available: false; auth: null };

function readStoredAuthState(): StoredAuth {
  if (typeof window === 'undefined') return { available: false, auth: null };
  try {
    return { available: true, auth: localStorage.getItem(STORAGE_KEY) };
  } catch {
    return { available: false, auth: null };
  }
}

function readStoredAuth(): string | null {
  return readStoredAuthState().auth;
}

function startBrowserStore(): void {
  if (typeof window === 'undefined' || browserStoreStarted) return;
  browserStoreStarted = true;
  const stored = readStoredAuthState();
  authSnapshotPersisted = stored.available && stored.auth != null;
  publishAuth({ auth: stored.auth, needsAuth: false, hydrated: true });
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY) return;
    authSnapshotPersisted = event.newValue != null;
    publishAuth({
      auth: event.newValue,
      needsAuth: event.newValue == null,
      hydrated: true,
    });
  });
}

function subscribeAuth(listener: () => void): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

// The controller protects /settings, /debug and the admin POST endpoints with
// HTTP Basic. Every hook instance observes this one same-tab store: a 401 from
// a page query must reach AdminShell so its QueryClient is unmounted with the
// authenticated branch. The storage listener adds cross-tab propagation;
// same-tab writes publish directly because browsers do not emit storage there.
export function useAdminAuth(): AdminAuth {
  const snapshot = useSyncExternalStore(
    subscribeAuth,
    () => authSnapshot,
    () => SERVER_SNAPSHOT,
  );

  useEffect(() => {
    startBrowserStore();
  }, []);

  // Verify against the controller BEFORE caching. Caching unverified creds
  // silently "succeeds" on a wrong password, and every later admin call 401s,
  // which reads as a random logout.
  const signIn = useCallback(async (user: string, pass: string): Promise<SignInResult> => {
    const encode = (s: string) =>
      typeof window !== 'undefined' ? window.btoa(s) : Buffer.from(s).toString('base64');
    const token = encode(`${user}:${pass}`);
    let r: Response;
    try {
      r = await fetch(`${API_URL}/settings`, { headers: { Authorization: `Basic ${token}` } });
    } catch {
      return { ok: false, error: 'could not reach the controller' };
    }
    if (r.status === 401) return { ok: false, error: 'wrong username or password' };
    if (!r.ok) return { ok: false, error: `controller error (${r.status})` };
    try {
      localStorage.setItem(STORAGE_KEY, token);
      authSnapshotPersisted = localStorage.getItem(STORAGE_KEY) === token;
    } catch {
      authSnapshotPersisted = false;
    }
    publishAuth({ auth: token, needsAuth: false, hydrated: true });
    return { ok: true };
  }, []);

  const signOut = useCallback(() => {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    authSnapshotPersisted = false;
    publishAuth({ auth: null, needsAuth: true, hydrated: true });
  }, []);

  const adminFetch = useCallback(async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = { ...((init.headers as Record<string, string>) || {}) };
    // A component can request during the same commit that starts hydration, so
    // retain the persisted fallback until the external-store effect has run.
    const token = authSnapshot.auth || readStoredAuth();
    if (token) headers.Authorization = `Basic ${token}`;
    const r = await fetch(`${API_URL}${path}`, { ...init, headers });
    if (r.status === 401) {
      // localStorage is the cross-tab source of truth even before scheduling
      // delivers its StorageEvent. Read it first: a delayed B rejection cannot
      // remove an already-committed C merely because the external-store
      // snapshot still says B. Re-read immediately before removal to narrow
      // the check/clear window as far as synchronous browser storage permits.
      const stored = readStoredAuthState();
      const memoryOnlyOwner = stored.available
        && stored.auth == null
        && !authSnapshotPersisted
        && authSnapshot.auth === token;
      if ((stored.available && stored.auth === token) || memoryOnlyOwner) {
        if (token && stored.auth === token) {
          try {
            if (localStorage.getItem(STORAGE_KEY) !== token) return r;
            localStorage.removeItem(STORAGE_KEY);
          } catch {
            // Storage became unavailable between check and clear. The browser
            // offers no atomic compare-and-delete, so fall back to the still-
            // matching in-memory owner and leave persistence best-effort.
            if (authSnapshot.auth !== token) return r;
          }
        }
        authSnapshotPersisted = false;
        publishAuth({ auth: null, needsAuth: true, hydrated: true });
      } else if (!stored.available && authSnapshot.auth === token) {
        // Private-mode/storage-denied sessions still need ordinary page-owned
        // 401 teardown even though no cross-tab source can be consulted.
        authSnapshotPersisted = false;
        publishAuth({ auth: null, needsAuth: true, hydrated: true });
      }
    } else if (token && authSnapshot.auth === token && authSnapshot.needsAuth) {
      // A late response for credentials already rejected must not undo the
      // shared sign-out; only the store's current token may clear this flag.
      publishAuth({ ...authSnapshot, needsAuth: false });
    }
    return r;
  }, []);

  return { ...snapshot, signIn, signOut, adminFetch };
}

export { API_URL as ADMIN_API_URL };
