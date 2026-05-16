'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import SignInForm from './SignInForm';

const NAV = [
  { href: '/admin/dash',     label: 'Dash' },
  { href: '/admin/library',  label: 'Library' },
  { href: '/admin/persona',  label: 'Persona' },
  { href: '/admin/settings', label: 'Settings' },
  { href: '/admin/debug',    label: 'Debug' },
];

// Wraps every page under /admin. Renders the sidebar nav + sign-in gate.
// Children are admin panels that take an `adminFetch` and `auth` from the
// hook — they re-call useAdminAuth themselves to avoid prop-drilling.
export default function AdminShell({ children }) {
  const pathname = usePathname();
  const { auth, needsAuth, hydrated, signIn, signOut, adminFetch } = useAdminAuth();

  // On first paint after hydration, probe an admin endpoint so we surface
  // the sign-in form proactively if the cached token has been revoked.
  useEffect(() => {
    if (!hydrated || !auth) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch('/settings');
        if (cancelled) return;
        if (!r.ok && r.status !== 401) {
          // any non-auth failure surfaces inside the child page; ignore here
        }
      } catch {}
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, auth]);

  if (!hydrated) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)', color: 'var(--muted)' }}>
        <span className="italic">loading…</span>
      </div>
    );
  }

  // Authentication gate — covers both "no token yet" and "token rejected".
  if (!auth || needsAuth) {
    return (
      <div className="min-h-screen" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>
        <Header pathname={pathname} onSignOut={null} />
        <div className="max-w-7xl mx-auto px-4 lg:px-6 py-12">
          <SignInForm onSubmit={signIn} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>
      <Header pathname={pathname} onSignOut={signOut} />
      <div className="max-w-7xl mx-auto px-4 lg:px-6 py-6">
        <div className="grid gap-6" style={{ gridTemplateColumns: 'minmax(0, 180px) minmax(0, 1fr)' }}>
          <SideNav pathname={pathname} />
          <main style={{ minWidth: 0 }}>
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}

function Header({ pathname, onSignOut }) {
  const current = NAV.find(n => pathname?.startsWith(n.href))?.label || 'Admin';
  return (
    <header
      className="flex flex-wrap items-center gap-3 px-4 lg:px-6 py-3"
      style={{ borderBottom: '1px solid var(--ink)' }}
    >
      <h1 className="v3-eyebrow" style={{ fontSize: 13 }}>
        SUB/WAVE · ADMIN · {current}
      </h1>
      <Link
        href="/"
        className="v3-caption underline underline-offset-4 v3-focus"
        style={{ color: 'var(--muted)', textDecoration: 'underline' }}
      >
        ← player
      </Link>
      {onSignOut && (
        <button
          onClick={onSignOut}
          className="ml-auto v3-eyebrow v3-focus cursor-pointer"
          style={{
            border: '1px solid var(--ink)',
            background: 'transparent',
            color: 'var(--ink)',
            padding: '4px 10px',
            fontSize: 10,
          }}
        >
          sign out
        </button>
      )}
    </header>
  );
}

function SideNav({ pathname }) {
  return (
    <nav style={{ borderRight: '1px solid var(--separator-strong)', paddingRight: 16 }}>
      <ul className="space-y-1">
        {NAV.map(item => {
          const active = pathname?.startsWith(item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className="v3-focus block"
                style={{
                  textDecoration: 'none',
                  color: active ? 'var(--bg)' : 'var(--ink)',
                  background: active ? 'var(--ink)' : 'transparent',
                  border: '1px solid var(--ink)',
                  padding: '8px 12px',
                  fontSize: 12,
                  letterSpacing: '0.15em',
                  textTransform: 'uppercase',
                }}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
