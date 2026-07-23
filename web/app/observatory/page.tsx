'use client';

// Standalone full-bleed Library Observatory. Lives outside the AdminShell grid
// (it wants the whole viewport + its own top bar) but reuses the same admin
// auth: the library data behind it is admin-gated, so we gate on useAdminAuth
// and show the shared SignInForm until the operator is signed in.
import { useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import type { SignInResult } from '../../lib/adminAuth';
import SignInForm from '../../components/admin/SignInForm';
import ObservatoryApp from '../../components/observatory/ObservatoryApp';

export default function ObservatoryPage() {
  const { auth, needsAuth, hydrated, signIn, adminFetch } = useAdminAuth();
  const [signingIn, setSigningIn] = useState(false);

  // Wrap the async sign-in so the gate reflects its pending state (aria-busy)
  // while the request is in flight — the submit button inside SignInForm also
  // disables itself, so a duplicate submission can't slip through.
  const handleSignIn = async (user: string, pass: string): Promise<SignInResult> => {
    setSigningIn(true);
    try {
      return await signIn(user, pass);
    } finally {
      setSigningIn(false);
    }
  };

  if (!hydrated) {
    return (
      <div className="observatory-root" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <span className="t-caption ad-muted">loading…</span>
      </div>
    );
  }

  if (!auth || needsAuth) {
    return (
      <div className="observatory-root" style={{ justifyContent: 'center' }} aria-busy={signingIn}>
        <div style={{ width: '100%', maxWidth: 1440, margin: '0 auto', padding: '48px 28px' }}>
          <SignInForm onSubmit={handleSignIn} />
        </div>
      </div>
    );
  }

  return <ObservatoryApp adminFetch={adminFetch} />;
}
