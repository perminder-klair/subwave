'use client';

import { useCallback, useEffect, useState } from 'react';

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

// Shared admin auth state. The controller protects /settings, /debug, and the
// admin POST endpoints with HTTP Basic; we cache a base64 token in
// localStorage so the user only signs in once per browser.
export function useAdminAuth(): AdminAuth {
  const [auth, setAuth] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setAuth(stored);
    } catch {}
    setHydrated(true);
  }, []);

  // Verifies the credentials against the controller before caching them.
  // Caching unverified creds silently "succeeds" on a wrong password, then
  // every later admin call 401s — which reads as a random logout. Returns
  // { ok } / { ok:false, error } so the sign-in form can surface a message.
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
    setAuth(token);
    setNeedsAuth(false);
    return { ok: true };
  }, []);

  const signOut = useCallback(() => {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    setAuth(null);
    setNeedsAuth(true);
  }, []);

  // Wraps fetch so every admin call carries the Authorization header and
  // flips us into the sign-in flow on 401.
  const adminFetch = useCallback(async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = { ...((init.headers as Record<string, string>) || {}) };
    // Resolve the token from state, falling back to the persisted copy. A
    // freshly mounted hook instance can fire a request from a mount effect
    // BEFORE its own hydration effect has copied the token out of localStorage
    // into `auth`. Without this fallback that first request goes out
    // unauthenticated, the controller answers 401 + `WWW-Authenticate: Basic`,
    // and the browser pops its NATIVE basic-auth dialog over the app (the
    // symptom seen when opening the skill-edit modal).
    let token = auth;
    if (!token && typeof window !== 'undefined') {
      try { token = localStorage.getItem(STORAGE_KEY); } catch {}
    }
    if (token) headers.Authorization = `Basic ${token}`;
    const r = await fetch(`${API_URL}${path}`, { ...init, headers });
    if (r.status === 401) {
      // Only treat a 401 as a revoked token when we actually sent
      // credentials. A 401 on a call made with no token at all must not wipe a
      // valid token that a sibling useAdminAuth instance is relying on.
      if (token) {
        try { localStorage.removeItem(STORAGE_KEY); } catch {}
        setAuth(null);
      }
      setNeedsAuth(true);
    } else if (needsAuth) {
      setNeedsAuth(false);
    }
    return r;
  }, [auth, needsAuth]);

  return { auth, needsAuth, hydrated, signIn, signOut, adminFetch };
}

export { API_URL as ADMIN_API_URL, STORAGE_KEY as ADMIN_STORAGE_KEY };
