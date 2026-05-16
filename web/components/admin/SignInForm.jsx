'use client';

import { useState } from 'react';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { FieldGroup, Field, FieldDescription, FieldError } from '../ui/field';

export default function SignInForm({ onSubmit }) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e?.preventDefault?.();
    if (!user || !pass || busy) return;
    setBusy(true);
    setErr(null);
    const res = await onSubmit(user, pass);
    // On success the gate swaps this form out; only handle failure here.
    if (res && !res.ok) {
      setErr(res.error || 'sign-in failed');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ border: '1px solid var(--ink)', maxWidth: 420, margin: '0 auto' }}>
      <div className="px-4 py-2" style={{ borderBottom: '1px solid var(--ink)' }}>
        <span className="v3-eyebrow" style={{ fontSize: 11 }}>Admin sign-in</span>
      </div>
      <div className="p-5">
        <FieldGroup className="gap-3">
          <FieldDescription>
            The controller requires admin credentials for the admin panel.
            They&apos;re cached in this browser only.
          </FieldDescription>
          <Field>
            <Input
              type="text"
              autoComplete="username"
              placeholder="username"
              value={user}
              onChange={e => setUser(e.target.value)}
              autoFocus
            />
          </Field>
          <Field data-invalid={err ? true : undefined}>
            <Input
              type="password"
              autoComplete="current-password"
              placeholder="password"
              value={pass}
              onChange={e => setPass(e.target.value)}
              aria-invalid={err ? true : undefined}
            />
            <FieldError>{err}</FieldError>
          </Field>
          <Button type="submit" variant="accent" disabled={!user || !pass || busy}>
            {busy ? 'signing in…' : 'sign in'}
          </Button>
        </FieldGroup>
      </div>
    </form>
  );
}
