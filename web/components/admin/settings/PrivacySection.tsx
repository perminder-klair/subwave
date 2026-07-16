'use client';

// Private-station controls (#478): hide the public player pages, and/or put a
// shared listener password on the Icecast stream mounts. The password is one
// station-wide secret (Icecast can only do basic auth — no per-user accounts);
// external clients tune in with user:pass@ URLs, the web player prompts for
// the same password and rides it as an ?auth= token.

import type { ChangeEvent } from 'react';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Card, Btn, Pill, Seg } from '../ui';
import { SectionHeader, type SectionProps } from './shared';

const ON_OFF = [
  { id: 'on', label: 'On' },
  { id: 'off', label: 'Off' },
] as const;

export function PrivacySection({ data, form, setForm, busy, saveSettings }: SectionProps) {
  const save = () =>
    saveSettings({
      privacy: {
        privatePlayer: form.privacy.privatePlayer,
        listenerAuth: form.privacy.listenerAuth,
        // 'set' is the redaction sentinel — the controller ignores it, so an
        // untouched field never clobbers the stored password.
        listenerPassword: form.privacy.listenerPassword,
      },
    });

  const authOnFile = data.values?.privacy?.listenerAuth === true;
  const passwordOnFile = data.values?.privacy?.listenerPassword === 'set';

  return (
    <>
      <SectionHeader
        eyebrow="privacy"
        title="Keep the station off the open web."
        sub="Two independent locks. The private player swaps the public web pages for a “this station is private” screen (applies live). The stream password makes Icecast demand credentials on every mount — the real boundary, since the mount URLs are guessable. Now-playing metadata endpoints stay public either way."
        metrics={[
          { n: authOnFile ? 'locked' : 'open', l: 'stream', accent: authOnFile },
        ]}
      />

      <Card title="Public player pages" sub="/ and /listen">
        <div className="field">
          <Label>Private player</Label>
          <div className="flex items-center gap-2">
            <Seg
              options={[...ON_OFF]}
              value={form.privacy.privatePlayer ? 'on' : 'off'}
              onChange={id =>
                setForm(f => ({ ...f, privacy: { ...f.privacy, privatePlayer: id === 'on' } }))
              }
            />
          </div>
          <div className="field-hint">
            On: the player pages show a minimal “this station is private” screen with a
            link to the admin sign-in; /admin and /onboarding keep working. Applies live
            on the player&apos;s next poll. This hides the UI only — pair it with the
            stream password below to actually gate the audio.
          </div>
        </div>
      </Card>

      <Card title="Stream password" sub="Icecast listener auth on every mount">
        <div className="grid gap-3">
          <div className="field">
            <div className="flex items-center gap-2">
              <Label>Require a password to listen</Label>
              <Pill tone="ink">restart required</Pill>
            </div>
            <div className="flex items-center gap-2">
              <Seg
                options={[...ON_OFF]}
                value={form.privacy.listenerAuth ? 'on' : 'off'}
                onChange={id =>
                  setForm(f => ({ ...f, privacy: { ...f.privacy, listenerAuth: id === 'on' } }))
                }
              />
            </div>
            <div className="field-hint">
              Icecast checks every listener connect against the controller. Turning this
              on or off needs a mixer restart (danger zone) to re-render the Icecast
              config; password changes apply live. While it&apos;s on, the tune-in files
              (/listen.pls, /listen.m3u) are disabled, and if the controller is down new
              listeners can&apos;t connect (already-tuned listeners keep playing).
            </div>
          </div>
          <div className="field">
            <Label>Listener password</Label>
            <div className="flex items-center gap-2">
              <Input
                type="password"
                placeholder={passwordOnFile ? '••••••••  (saved)' : 'shared station password'}
                value={form.privacy.listenerPassword === 'set' ? '' : form.privacy.listenerPassword}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setForm(f => ({ ...f, privacy: { ...f.privacy, listenerPassword: e.target.value } }))
                }
                className="w-[260px]"
                maxLength={128}
                autoComplete="new-password"
              />
              <Btn tone="accent" onClick={save} disabled={busy}>Save</Btn>
            </div>
            <div className="field-hint">
              One shared password for everyone (Icecast is basic-auth only). The web
              player asks for it once and remembers it. Radio apps, VLC, Sonos and the
              native app tune in with{' '}
              <code>https://listener:PASSWORD@your-station/stream.mp3</code> — or append{' '}
              <code>?auth=PASSWORD</code> to the stream URL where userinfo isn&apos;t
              supported. No whitespace; max 128 chars.
            </div>
          </div>
        </div>
      </Card>
    </>
  );
}
