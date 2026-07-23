'use client';

import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { FieldGroup, Field, FieldDescription, FieldError } from '../ui/field';
import type { SignInResult } from '../../lib/adminAuth';

export interface SignInFormProps {
  onSubmit: (user: string, pass: string) => Promise<SignInResult>;
}

export default function SignInForm({ onSubmit }: SignInFormProps) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errId = useId();

  const submit = async (e: FormEvent<HTMLFormElement>) => {
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
    <form onSubmit={submit} className="mx-auto max-w-[420px] border border-ink">
      <div className="border-b border-ink px-4 py-2">
        <span className="v3-eyebrow text-[11px]">Admin sign-in</span>
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
              aria-label="Username"
              required
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
              aria-label="Password"
              required
              minLength={1}
              value={pass}
              onChange={e => setPass(e.target.value)}
              aria-invalid={err ? true : undefined}
              aria-describedby={err ? errId : undefined}
            />
            <FieldError id={errId}>{err}</FieldError>
          </Field>
          <Button type="submit" variant="accent" disabled={!user || !pass || busy}>
            {busy ? 'signing in…' : 'sign in'}
          </Button>
        </FieldGroup>
      </div>
    </form>
  );
}
