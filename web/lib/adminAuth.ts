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

function readStoredAuth(): string | null {
  if (typeof window === 'undefined') return null;
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

function startBrowserStore(): void {
  if (typeof window === 'undefined' || browserStoreStarted) return;
  browserStoreStarted = true;
  const stored = readStoredAuth();
  publishAuth({ auth: stored, needsAuth: false, hydrated: true });
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY) return;
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
    try { localStorage.setItem(STORAGE_KEY, token); } catch {}
    publishAuth({ auth: token, needsAuth: false, hydrated: true });
    return { ok: true };
  }, []);

  const signOut = useCallback(() => {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
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
      // The request may have outlived the credential that started it. A late
      // 401 for A must never sign out B after a same-tab login or cross-tab
      // storage update; only the credential that is still current owns the
      // rejection. `readStoredAuth` covers the hydration edge before the
      // external store has observed localStorage.
      const current = authSnapshot.auth ?? readStoredAuth();
      if (current === token) {
        if (token) {
          try { localStorage.removeItem(STORAGE_KEY); } catch {}
        }
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
