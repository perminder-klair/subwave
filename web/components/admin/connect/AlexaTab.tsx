'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useCopyToClipboard } from 'usehooks-ts';
import { HelpCircle } from 'lucide-react';
import { adminJson, useAdminMutation, useAdminQuery, type AdminFetch } from '../../../lib/admin-query';
import { errorMessage, notify } from '../../../lib/notify';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Card, Btn, Pill, Seg, Toggle } from '../ui';

interface AlexaConnection {
  station: string;
  stationDescription: string;
  siteUrl: string;
  webhookUrl: string;
  streamUrl: string;
  streamMount: string;
  streamOptions: Array<{
    mount: string;
    label: string;
    description: string;
    enabled: boolean;
  }>;
  listenerAuth: boolean;
  directSkill: { enabled: boolean; skillId: string; tokenTtlHours: number };
  intentPolicy: AlexaIntentPolicy;
  intentGroups: AlexaIntentGroup[];
}

interface AlexaIntentPolicy {
  version: 1;
  mode: 'allowlist';
  allowed: string[];
}

interface AlexaIntentCapability {
  id: string;
  group: string;
  label: string;
  description: string;
  intentNames: string[];
  configurable: boolean;
  required?: boolean;
}

interface AlexaIntentGroup {
  id: string;
  label: string;
  description: string;
  capabilities: AlexaIntentCapability[];
}

interface AlexaConnectionTest {
  ok: boolean;
  testedAt: string;
  checks: Array<{ id: string; label: string; ok: boolean; message: string }>;
}

interface AlexaDraft {
  enabled: boolean;
  skillId: string;
  streamMount: string;
  tokenTtlHours: number;
}

const keys = { connection: ['connect', 'alexa'] as const };

function alexaDraftKey(draft: AlexaDraft): string {
  return JSON.stringify({
    enabled: draft.enabled,
    skillId: draft.skillId.trim(),
    streamMount: draft.streamMount,
    tokenTtlHours: draft.tokenTtlHours,
  });
}

function intentPolicyKey(policy: AlexaIntentPolicy): string {
  return JSON.stringify({
    version: policy.version,
    mode: policy.mode,
    allowed: [...policy.allowed].sort(),
  });
}

function capabilityEnabled(policy: AlexaIntentPolicy, capability: AlexaIntentCapability): boolean {
  return capability.required === true || policy.allowed.includes(capability.id);
}

function setCapability(
  policy: AlexaIntentPolicy,
  capability: AlexaIntentCapability,
  enabled: boolean,
): AlexaIntentPolicy {
  if (!capability.configurable || capability.required) return policy;
  const allowed = new Set(policy.allowed);
  if (enabled) allowed.add(capability.id);
  else allowed.delete(capability.id);
  return { ...policy, allowed: [...allowed] };
}

function CopyValue({ value }: { value: string }) {
  const [, copy] = useCopyToClipboard();
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 flex-1 truncate text-[12px]">{value}</code>
      <Btn sm onClick={async () => (await copy(value)) ? notify.info('Copied') : notify.err('Could not copy')}>Copy</Btn>
    </div>
  );
}

function AlexaStreamUrlField({
  siteUrl,
  streamMount,
  streamOptions,
  listenerAuth,
  onMountChange,
}: {
  siteUrl: string;
  streamMount: string;
  streamOptions: AlexaConnection['streamOptions'];
  listenerAuth: boolean;
  onMountChange: (mount: string) => void;
}) {
  const [, copy] = useCopyToClipboard();
  const origin = siteUrl.replace(/\/+$/, '');
  const fullUrl = `${origin}${streamMount}`;
  const selected = streamOptions.find(option => option.mount === streamMount);

  return (
    <div className="grid gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 border border-ink bg-[var(--ink-softer)] px-2 py-1.5">
          <code className="min-w-0 truncate text-[12px]">{origin}</code>
          <select
            aria-label="Alexa stream format"
            value={streamMount}
            onChange={event => onMountChange(event.target.value)}
            className="min-w-[8rem] cursor-pointer border border-ink bg-bg px-2 py-1 font-mono text-[12px] text-ink outline-none"
          >
            {streamOptions.map(option => (
              <option key={option.mount} value={option.mount} disabled={!option.enabled}>
                {option.label} ({option.mount}){option.enabled ? '' : ' — enable first'}
              </option>
            ))}
          </select>
        </div>
        <Btn
          sm
          onClick={async () => (await copy(fullUrl)) ? notify.info('Copied full Alexa stream URL') : notify.err('Could not copy')}
        >
          Copy
        </Btn>
      </div>
      <div className="field-hint">
        {selected?.description || 'Select an enabled stream mount.'} The copied value is the underlying mount URL: <code className="break-all">{fullUrl}</code>. {listenerAuth ? 'When playback starts, Alexa receives a temporary signed version of this URL; the station password is never sent.' : 'With listener authentication off, this is the direct URL Alexa receives.'}
      </div>
    </div>
  );
}

function Guide({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="presentation" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="alexa-guide-title"
        className="max-h-[90vh] w-full max-w-xl overflow-auto border border-ink bg-bg p-5 text-ink shadow-2xl"
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="eyebrow text-vermilion">how this works</div>
            <h2 id="alexa-guide-title" className="mt-1 text-lg font-bold">Connect your Alexa skill</h2>
          </div>
          <Btn sm onClick={onClose} aria-label="Close Alexa guide">Close</Btn>
        </div>
        <div className="mt-4 grid gap-3 text-[13px] leading-[1.65] text-muted">
          <p>This deployment uses your own Alexa Custom Skill. The station name is dynamic, so the skill speaks whatever name you set in Station settings.</p>
          <p>In the Alexa Developer Console, set the skill endpoint to the <code className="text-ink">Alexa webhook endpoint</code> shown below. Set the same Skill ID here, enable the direct skill, and save.</p>
          <p>The skill returns the selected stream mount to Alexa. With listener authentication off, Alexa receives the direct URL. With listener authentication on, SUB/WAVE creates a fresh, short-lived signed URL for each play or resume request. Choose MP3, Opus, FLAC, or AAC only after enabling that stream mount in SUB/WAVE.</p>
          <p>This setup is private to the skill you own. It does not publish the station to an Alexa catalog or require a shared broker. Password-protected listener streams are supported: the station password stays private, while the temporary Alexa token is checked by the existing listener-auth hook.</p>
          <p className="text-amber-200">The signed URL is a bearer credential until it expires. Set its lifetime below, avoid sharing it, and remember that an already-connected stream is not interrupted at expiry; Alexa receives a new token when it reconnects.</p>
          <p className="text-amber-200">Alexa Developer Console availability rules still apply. Development skills are normally limited to the developer account and test devices; public distribution requires Amazon certification.</p>
          <p className="border-t border-separator-strong pt-3">
            <Link href="/manual/alexa" className="font-bold text-ink underline-offset-2 hover:underline" onClick={onClose}>
              Read the full Alexa setup manual ↗
            </Link>{' '}
            for invocation-name rules, development-mode testing, certificate fixes, Skill ID lookup, and troubleshooting.
          </p>
        </div>
      </section>
    </div>
  );
}

export default function AlexaTab({ adminFetch }: { adminFetch: AdminFetch }) {
  const connection = useAdminQuery<AlexaConnection>({
    key: keys.connection,
    adminFetch,
    request: (fetcher, signal) => adminJson<AlexaConnection>(fetcher, '/alexa/connection', undefined, signal),
    refetchInterval: 30_000,
    toastOnError: false,
  });
  const data = connection.data;
  const [guideOpen, setGuideOpen] = useState(false);
  const [directEnabled, setDirectEnabled] = useState(false);
  const [skillId, setSkillId] = useState('');
  const [streamMount, setStreamMount] = useState('/stream.mp3');
  const [tokenTtlHours, setTokenTtlHours] = useState('24');
  const [testResult, setTestResult] = useState<AlexaConnectionTest | null>(null);
  const [testedDraftKey, setTestedDraftKey] = useState<string | null>(null);
  const [directTouched, setDirectTouched] = useState(false);
  const [intentPolicyDraft, setIntentPolicyDraft] = useState<AlexaIntentPolicy>({ version: 1, mode: 'allowlist', allowed: [] });
  const [intentPolicyTouched, setIntentPolicyTouched] = useState(false);

  useEffect(() => {
    if (!data) return;
    if (!directTouched) {
      setDirectEnabled(data.directSkill.enabled);
      setSkillId(data.directSkill.skillId);
      setStreamMount(data.streamMount || '/stream.mp3');
      setTokenTtlHours(String(data.directSkill.tokenTtlHours || 24));
    }
    if (!intentPolicyTouched) {
      setIntentPolicyDraft({
        version: data.intentPolicy.version,
        mode: data.intentPolicy.mode,
        allowed: [...data.intentPolicy.allowed],
      });
    }
  }, [data, directTouched, intentPolicyTouched]);

  const directMutation = useAdminMutation<Record<string, unknown>, { enabled: boolean; skillId: string; streamMount: string; tokenTtlHours: number }>({
    adminFetch,
    request: (vars, fetcher) => adminJson<Record<string, unknown>>(fetcher, '/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alexa: vars }),
    }),
    onDone: async (_result, _vars, client) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.connection }),
        client.invalidateQueries({ queryKey: ['settings', 'detail'] }),
      ]);
      setDirectTouched(false);
      setTestResult(null);
      setTestedDraftKey(null);
      notify.ok('Direct Alexa skill settings saved');
    },
    toastOnError: false,
  });

  const testMutation = useAdminMutation<AlexaConnectionTest, AlexaDraft>({
    adminFetch,
    request: (vars, fetcher) => adminJson<AlexaConnectionTest>(fetcher, '/alexa/connection/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(vars),
    }),
    onDone: (result, vars) => {
      setTestResult(result);
      setTestedDraftKey(alexaDraftKey(vars));
      if (result.ok) notify.ok('Alexa connection test passed');
      else notify.err('Alexa connection test found issues');
    },
    toastOnError: false,
  });

  const intentPolicyMutation = useAdminMutation<Record<string, unknown>, AlexaIntentPolicy>({
    adminFetch,
    request: (vars, fetcher) => adminJson<Record<string, unknown>>(fetcher, '/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alexa: { intentPolicy: vars } }),
    }),
    onDone: async (_result, _vars, client) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.connection }),
        client.invalidateQueries({ queryKey: ['settings', 'detail'] }),
      ]);
      setIntentPolicyTouched(false);
      notify.ok('Alexa listener access saved');
    },
    toastOnError: false,
  });

  if (connection.isPending && !data) return <Card title="Alexa"><div className="text-[12px] text-muted">Loading Alexa connection…</div></Card>;
  if (connection.error && !data) return <Card title="Alexa"><div className="text-[12px] text-red-300">{errorMessage(connection.error)}</div></Card>;
  if (!data) return null;

  const parsedTokenTtlHours = Number.parseInt(tokenTtlHours, 10);
  const draft: AlexaDraft = {
    enabled: directEnabled,
    skillId: skillId.trim(),
    streamMount,
    tokenTtlHours: Number.isFinite(parsedTokenTtlHours) ? parsedTokenTtlHours : 24,
  };
  const draftKey = alexaDraftKey(draft);
  const testPassedForDraft = testResult?.ok === true && testedDraftKey === draftKey;
  const canSave = !directEnabled || testPassedForDraft;
  const intentPolicyDirty = intentPolicyKey(intentPolicyDraft) !== intentPolicyKey(data.intentPolicy);
  const setIntentCapability = (capability: AlexaIntentCapability, enabled: boolean) => {
    setIntentPolicyTouched(true);
    setIntentPolicyDraft(current => setCapability(current, capability, enabled));
  };
  const setIntentGroup = (group: AlexaIntentGroup, enabled: boolean) => {
    setIntentPolicyTouched(true);
    setIntentPolicyDraft(current => group.capabilities.reduce(
      (next, capability) => setCapability(next, capability, enabled),
      current,
    ));
  };
  const capabilityById = new Map(data.intentGroups.flatMap(group => group.capabilities).map(capability => [capability.id, capability]));

  return (
    <>
      <Guide open={guideOpen} onClose={() => setGuideOpen(false)} />

      <div className="grid gap-4">
        <Card
          title={<span className="flex items-center gap-2">Host your own Alexa skill <button type="button" className="cursor-pointer text-muted hover:text-ink" aria-label="Open Alexa setup guide" onClick={() => setGuideOpen(true)}><HelpCircle size={16} /></button></span>}
          sub="Connect this deployment to a skill you own in the Alexa Developer Console."
          right={data.directSkill.enabled ? <Pill tone="accent" dot>enabled</Pill> : <Pill>disabled</Pill>}
        >
          <div className="grid gap-3">
            <div className="grid gap-3 border-b border-separator-strong pb-4">
              <div className="caption">Deployment URLs</div>
              {data.siteUrl ? (
                <>
                  <div className="field">
                    <Label>Public station URL (SITE_URL)</Label>
                    <CopyValue value={data.siteUrl} />
                    <div className="field-hint">This is read from the controller deployment. Set <code>SITE_URL</code> in the deployment environment; it is not an Alexa skill setting.</div>
                  </div>
                  <div className="field">
                    <Label>Alexa webhook endpoint</Label>
                    <CopyValue value={data.webhookUrl || `${data.siteUrl}/api/alexa`} />
                    <div className="field-hint">Copy this complete URL into the Alexa Developer Console under the skill endpoint.</div>
                  </div>
                  <div className="field">
                    <Label>Stream URL returned to Alexa</Label>
                    <AlexaStreamUrlField
                      siteUrl={data.siteUrl}
                      streamMount={streamMount}
                      streamOptions={data.streamOptions}
                      listenerAuth={data.listenerAuth}
                      onMountChange={mount => { setDirectTouched(true); setTestResult(null); setTestedDraftKey(null); setStreamMount(mount); }}
                    />
                  </div>
                </>
              ) : (
                <div className="text-[12px] text-amber-200">
                  <code>SITE_URL</code> is not configured. Set it to the public HTTPS origin of this station, restart the controller, then return here.
                </div>
              )}
            </div>
            <div className="field">
              <Label>Enable direct skill</Label>
              <Seg options={[{ id: 'on', label: 'On' }, { id: 'off', label: 'Off' }]} value={directEnabled ? 'on' : 'off'} onChange={id => { setDirectTouched(true); setTestResult(null); setTestedDraftKey(null); setDirectEnabled(id === 'on'); }} />
            </div>
            <div className="field">
              <Label>Alexa Skill ID</Label>
              <Input value={skillId} onChange={event => { setDirectTouched(true); setTestResult(null); setTestedDraftKey(null); setSkillId(event.target.value); }} placeholder="amzn1.ask.skill.…" className="w-[420px] max-w-full font-mono text-xs" maxLength={200} />
              <div className="field-hint">The Skill ID is saved in this deployment; the webhook URL is configured in your Alexa skill.</div>
            </div>
            <div className="field">
              <Label>Alexa signed-stream lifetime</Label>
              {data.listenerAuth ? (
                <select
                  aria-label="Alexa signed-stream lifetime"
                  value={tokenTtlHours}
                  onChange={event => { setDirectTouched(true); setTestResult(null); setTestedDraftKey(null); setTokenTtlHours(event.target.value); }}
                  className="w-[18rem] max-w-full border border-ink bg-[var(--ink-softer)] px-2 py-1.5 text-[12px] text-ink outline-none"
                >
                  {[1, 6, 12, 24, 48, 72, 168].map(hours => <option key={hours} value={hours}>{hours < 24 ? `${hours} hour${hours === 1 ? '' : 's'}` : `${hours / 24} day${hours === 24 ? '' : 's'}`}</option>)}
                </select>
              ) : (
                <span className="inline-block" title="Enable listener authentication to configure the Alexa signed-stream lifetime">
                  <select
                    aria-label="Alexa signed-stream lifetime"
                    disabled
                    value={tokenTtlHours}
                    onChange={() => undefined}
                    className="w-[18rem] max-w-full cursor-not-allowed border border-ink bg-[var(--ink-softer)] px-2 py-1.5 text-[12px] text-ink opacity-50 outline-none"
                  >
                    {[1, 6, 12, 24, 48, 72, 168].map(hours => <option key={hours} value={hours}>{hours < 24 ? `${hours} hour${hours === 1 ? '' : 's'}` : `${hours / 24} day${hours === 24 ? '' : 's'}`}</option>)}
                  </select>
                </span>
              )}
              <div className="field-hint">Only used when listener authentication is enabled. A new token is generated for every play or resume request. Expiry affects reconnections, not an active stream.</div>
            </div>
            {data.listenerAuth && directEnabled && <div className="text-[12px] text-[color:var(--accent)]">Listener authentication is enabled. Alexa will receive a temporary signed URL for the selected mount; the normal listener URL remains password-protected.</div>}
            <div className="flex flex-wrap gap-2">
              <Btn tone="accent" disabled={testMutation.isPending} onClick={() => testMutation.mutate(draft)}>{testMutation.isPending ? 'Testing…' : 'Test connection'}</Btn>
              <Btn disabled={directMutation.isPending || !canSave} onClick={() => directMutation.mutate(draft)}>{directMutation.isPending ? 'Saving…' : 'Save advanced skill'}</Btn>
            </div>
            {directEnabled && !testPassedForDraft && <div className="field-hint">Test the current Alexa settings before saving. Changing any field requires another test.</div>}
            {!directEnabled && <div className="field-hint">The direct skill is off, so you can save this disabled state without testing the external Alexa endpoint.</div>}
            {testResult && (
              <div
                role="status"
                aria-live="polite"
                className={`grid gap-1 border bg-[var(--ink-softer)] px-3 py-2 text-[11px] leading-[1.6] ${testResult.ok ? 'border-[var(--accent)]' : 'border-[var(--danger)]'}`}
              >
                <div className="font-bold">{testResult.ok ? '✓ Alexa connection test passed' : '✗ Alexa connection test found issues'}</div>
                {testResult.checks.map(check => (
                  <div key={check.id} className={check.ok ? 'text-[color:var(--accent)]' : 'text-[color:var(--danger)]'}>
                    {check.ok ? '✓' : '✗'} <b>{check.label}:</b> {check.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        <Card
          title="Listener intent access"
          sub="Choose which listener actions this station accepts. Equivalent Alexa aliases are controlled together."
          right={<Pill tone="ink">allowlist</Pill>}
        >
          <div className="grid gap-4">
            <div className="field-hint">
              The allowlist applies to this station. New capabilities are off until enabled. Required Alexa behavior stays available so listeners can pause, stop, get help, and complete confirmations.
            </div>
            <div className="grid gap-3">
              {data.intentGroups.map(group => {
                const configurable = group.capabilities.filter(capability => capability.configurable && !capability.required);
                const enabledCount = group.capabilities.filter(capability => capabilityEnabled(intentPolicyDraft, capability)).length;
                const allEnabled = configurable.length > 0 && configurable.every(capability => capabilityEnabled(intentPolicyDraft, capability));
                return (
                  <section key={group.id} className="grid gap-3 border border-separator-strong p-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-[13px] font-bold text-ink">
                          {group.label}
                          <Pill tone="ink">{enabledCount}/{group.capabilities.length} enabled</Pill>
                        </div>
                        <div className="mt-1 text-[11px] leading-[1.5] text-muted">{group.description}</div>
                      </div>
                      {configurable.length > 0 && (
                        <div className="flex shrink-0 gap-2">
                          <Btn sm disabled={intentPolicyMutation.isPending || allEnabled} onClick={() => setIntentGroup(group, true)}>Enable all</Btn>
                          <Btn sm disabled={intentPolicyMutation.isPending || !allEnabled && configurable.every(capability => !capabilityEnabled(intentPolicyDraft, capability))} onClick={() => setIntentGroup(group, false)}>Disable all</Btn>
                        </div>
                      )}
                    </div>
                    <div className="grid gap-2 md:grid-cols-2">
                      {group.capabilities.map(capability => {
                        const enabled = capabilityEnabled(intentPolicyDraft, capability);
                        return (
                          <div key={capability.id} className="flex min-w-0 items-start justify-between gap-3 border border-separator-strong bg-[var(--ink-softer)] p-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2 text-[12px] font-bold text-ink">
                                <span>{capability.label}</span>
                                {capability.required && <Pill tone="ink">required</Pill>}
                              </div>
                              <div className="mt-1 text-[11px] leading-[1.5] text-muted">{capability.description}</div>
                              <div className="mt-2 flex flex-wrap gap-1">
                                {capability.intentNames.map(intentName => <code key={intentName} className="border border-separator-strong px-1 py-0.5 text-[10px] text-muted">{intentName}</code>)}
                              </div>
                            </div>
                            <Toggle
                              on={enabled}
                              disabled={capability.required === true}
                              onClick={() => setIntentCapability(capability, !enabled)}
                              ariaLabel={`${enabled ? 'Disable' : 'Enable'} ${capability.label}`}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Btn
                tone="accent"
                disabled={intentPolicyMutation.isPending || !intentPolicyDirty}
                onClick={() => intentPolicyMutation.mutate(intentPolicyDraft)}
              >
                {intentPolicyMutation.isPending ? 'Saving…' : 'Save listener access'}
              </Btn>
              <Btn
                disabled={intentPolicyMutation.isPending || !intentPolicyDirty}
                onClick={() => {
                  setIntentPolicyDraft({ ...data.intentPolicy, allowed: [...data.intentPolicy.allowed] });
                  setIntentPolicyTouched(false);
                }}
              >
                Discard changes
              </Btn>
              {intentPolicyDirty && <span className="field-hint">Unsaved listener access changes.</span>}
            </div>
          </div>
        </Card>

        <Card title="What listeners say" sub="The station name is dynamic; the skill invocation name is not.">
          <div className="grid gap-2 text-[12px] leading-[1.6] text-muted">
            <div><code>Alexa, open Subwave Radio</code> — replace <code>Subwave Radio</code> with the invocation name configured in your Alexa skill.</div>
            {capabilityById.get('playback.start') && capabilityEnabled(intentPolicyDraft, capabilityById.get('playback.start')!) && <div><code>Alexa, ask Subwave Radio to start the radio</code> — start this deployment&apos;s stream.</div>}
            {capabilityById.get('track.now') && capabilityEnabled(intentPolicyDraft, capabilityById.get('track.now')!) && <div><code>Alexa, ask Subwave Radio what is playing</code> — hear the current track.</div>}
            {capabilityById.get('request.song') && capabilityEnabled(intentPolicyDraft, capabilityById.get('request.song')!) && <div><code>Alexa, ask Subwave Radio to request a song</code> — submit a listener request.</div>}
            {capabilityById.get('request.dedication') && capabilityEnabled(intentPolicyDraft, capabilityById.get('request.dedication')!) && <div><code>Alexa, ask Subwave Radio to dedicate a song</code> — send a dedication.</div>}
            {capabilityById.get('request.reminder') && capabilityEnabled(intentPolicyDraft, capabilityById.get('request.reminder')!) && <div><code>Alexa, ask Subwave Radio to remind me when my request is coming up</code> — request a reminder.</div>}
            <div><code>Alexa, ask Subwave Radio to pause</code> or <code>stop</code> — control playback.</div>
            <div className="text-muted">The station name ({data.station}) is read in the confirmation. This skill controls one deployment; it does not select among multiple stations.</div>
          </div>
        </Card>
      </div>
    </>
  );
}
