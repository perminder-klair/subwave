'use client';

// Standalone full-bleed Library Observatory. Lives outside the AdminShell grid
// (it wants the whole viewport + its own top bar) but reuses the same admin
// auth: the library data behind it is admin-gated, so we gate on useAdminAuth
// and show the shared SignInForm until the operator is signed in.
import { useAdminAuth } from '../../lib/adminAuth';
import SignInForm from '../../components/admin/SignInForm';
import ObservatoryApp from '../../components/observatory/ObservatoryApp';

export default function ObservatoryPage() {
  const { auth, needsAuth, hydrated, signIn, adminFetch } = useAdminAuth();

  if (!hydrated) {
    return (
      <div className="observatory-root" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <span role="status" className="t-caption ad-muted">loading…</span>
      </div>
    );
  }

  if (!auth || needsAuth) {
    // No pending state to mirror here — SignInForm owns `busy`, sets aria-busy
    // on its own <form>, and disables the submit while a request is in flight.
    return (
      <div className="observatory-root" style={{ justifyContent: 'center' }}>
        <div style={{ width: '100%', maxWidth: 1440, margin: '0 auto', padding: '48px 28px' }}>
          <SignInForm onSubmit={signIn} />
        </div>
      </div>
    );
  }

  return <ObservatoryApp adminFetch={adminFetch} />;
}
