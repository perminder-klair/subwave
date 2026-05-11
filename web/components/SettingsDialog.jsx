'use client';

import { useEffect, useState } from 'react';
import { FullDialog } from './ui/dialog';
import { V3Switch } from './ui/switch';
import { fmtSize } from '../lib/format';
import { getStoredTheme, setTheme, THEME_MODES } from '../lib/theme';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

const FREQUENCIES = ['quiet', 'moderate', 'aggressive'];
const FREQUENCY_HINTS = {
  quiet:      'Quiet — talks every 8-20 tracks · station ID once an hour · weather hourly on change.',
  moderate:   'Moderate — talks every 1-9 tracks · station IDs at :15 and :45 · weather every 30 min on change.',
  aggressive: 'Aggressive — talks every 1-3 tracks · station IDs four times an hour · weather every 15 min on change.',
};

const AUTH_STORAGE_KEY = 'subwave_admin_auth';

export default function SettingsDialog({ open, onOpenChange, container }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [jingleText, setJingleText] = useState('');
  const [taggerLimit, setTaggerLimit] = useState('50');
  const [form, setForm] = useState(null);
  const [pendingRestart, setPendingRestart] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [themeMode, setThemeMode] = useState('system');
  // Base64-encoded `user:pass` for Basic auth. Null means we haven't been
  // challenged yet; `needsAuth` flips true when the controller returns 401.
  const [auth, setAuth] = useState(null);
  const [needsAuth, setNeedsAuth] = useState(false);

  useEffect(() => {
    setThemeMode(getStoredTheme());
    try {
      const stored = localStorage.getItem(AUTH_STORAGE_KEY);
      if (stored) setAuth(stored);
    } catch {}
  }, []);

  const pickTheme = (m) => { setTheme(m); setThemeMode(m); };

  // Wraps fetch so every admin call carries the Authorization header (when
  // we have credentials) and flips us into the sign-in flow on 401.
  const adminFetch = async (path, init = {}) => {
    const headers = { ...(init.headers || {}) };
    if (auth) headers.Authorization = `Basic ${auth}`;
    const r = await fetch(`${API_URL}${path}`, { ...init, headers });
    if (r.status === 401) {
      try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch {}
      setAuth(null);
      setNeedsAuth(true);
    } else if (needsAuth) {
      setNeedsAuth(false);
    }
    return r;
  };

  const signIn = (user, pass) => {
    const token = (typeof window !== 'undefined' ? window.btoa : (s => Buffer.from(s).toString('base64')))(`${user}:${pass}`);
    try { localStorage.setItem(AUTH_STORAGE_KEY, token); } catch {}
    setAuth(token);
    setNeedsAuth(false);
    setData(null);
    setForm(null);
  };

  // Refresh only updates the read-only `data` view — never touches `form`.
  // The form is hydrated exactly once via the effect below; otherwise the 3s
  // poll's stale closure would clobber unsaved edits every tick.
  const refresh = async () => {
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) return;
      const j = await r.json();
      setData(j); setErr(null);
    } catch (e) { setErr(e.message); }
  };

  useEffect(() => {
    if (!data?.values || form) return;
    setForm({
      jingleRatio: String(data.values.jingleRatio),
      crossfadeDuration: String(data.values.crossfadeDuration),
      weather: {
        ...data.values.weather,
        lat: String(data.values.weather.lat),
        lng: String(data.values.weather.lng),
      },
      dj: {
        name: data.values.dj?.name ?? '',
        soul: data.values.dj?.soul ?? '',
        systemPrompt: data.values.dj?.systemPrompt ?? '',
        frequency: data.values.dj?.frequency ?? 'moderate',
      },
    });
  }, [data, form]);

  useEffect(() => {
    if (!open || needsAuth) return;
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, needsAuth, auth]);

  const saveSettings = async (patch) => {
    setBusy(true); setSaveMsg(null);
    try {
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      if (j.requiresRestart) setPendingRestart(true);
      setSaveMsg({ tone: 'ok', text: j.requiresRestart ? 'saved — restart the mixer to apply' : 'saved' });
      await refresh();
    } catch (e) {
      setSaveMsg({ tone: 'err', text: e.message });
    } finally { setBusy(false); }
  };

  const restartMixer = async () => {
    if (!confirm('Restart the mixer? Broadcast will drop for ~3-5 seconds.')) return;
    setBusy(true);
    try {
      const r = await adminFetch('/restart-mixer', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setPendingRestart(false);
      setSaveMsg({ tone: 'ok', text: 'mixer restarting — give it a few seconds' });
    } catch (e) {
      setSaveMsg({ tone: 'err', text: e.message });
    } finally { setBusy(false); }
  };

  const createJingle = async () => {
    if (!jingleText.trim() || busy) return;
    setBusy(true);
    try {
      const r = await adminFetch('/jingles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: jingleText.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setJingleText('');
      await refresh();
    } catch (e) { alert(`Jingle creation failed: ${e.message}`); }
    finally { setBusy(false); }
  };

  const deleteJingle = async (filename) => {
    if (!confirm(`Delete ${filename}?`)) return;
    setBusy(true);
    try {
      const r = await adminFetch(`/jingles/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refresh();
    } catch (e) { alert(`Delete failed: ${e.message}`); }
    finally { setBusy(false); }
  };

  const toggleAutoPick = async () => {
    if (!data) return;
    setBusy(true);
    try {
      await adminFetch('/auto-pick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: !data.autoPick }),
      });
      await refresh();
    } finally { setBusy(false); }
  };

  const startTagger = async () => {
    setBusy(true);
    try {
      const limit = parseInt(taggerLimit, 10);
      const r = await adminFetch('/tag-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refresh();
    } catch (e) { alert(`Tagger start failed: ${e.message}`); }
    finally { setBusy(false); }
  };

  return (
    <FullDialog open={open} onOpenChange={onOpenChange} title="Settings" container={container}>
      <div className="max-w-3xl mx-auto space-y-7">
        {needsAuth && <SignInForm onSubmit={signIn} />}
        {!needsAuth && err && <Alert tone="err">controller error: {err}</Alert>}
        {!needsAuth && !data && !err && (
          <div style={{ color: 'var(--muted)' }} className="italic">loading…</div>
        )}

        {data && !needsAuth && (
          <>
            <Section title="Appearance">
              <Row>
                <div>
                  <Lead>Theme</Lead>
                  <Hint>
                    System follows your OS preference. Manual overrides persist in this browser only.
                  </Hint>
                </div>
                <ThemeSegmented value={themeMode} onChange={pickTheme} />
              </Row>
            </Section>

            <Section title="Auto-DJ">
              <Row>
                <div>
                  <Lead>LLM picks next track</Lead>
                  <Hint>
                    When listener queue is empty, Ollama chooses from mood-tagged candidates
                    instead of random shuffle.
                  </Hint>
                </div>
                <V3Switch checked={!!data.autoPick} onCheckedChange={toggleAutoPick} disabled={busy} />
              </Row>
              <Row>
                <div>
                  <Lead>Picker status</Lead>
                  <Hint>
                    {data.pickerBusy ? 'Asking Ollama for the next track…' : 'Idle — picks fire on each track change.'}
                  </Hint>
                </div>
                <span
                  className="v3-caption"
                  style={{ color: data.pickerBusy ? 'var(--accent)' : 'var(--muted)' }}
                >
                  {data.pickerBusy ? 'thinking' : 'idle'}
                </span>
              </Row>
              <Footnote>model: {data.ollama.model} @ {data.ollama.url}</Footnote>
            </Section>

            {form && (
              <Section title="DJ persona">
                <FormRow
                  label="Name"
                  hint="Shown in the TopBar and referenced by the LLM as the DJ's on-air name."
                >
                  <TextInput
                    value={form.dj.name}
                    onChange={e => setForm(f => ({ ...f, dj: { ...f.dj, name: e.target.value } }))}
                    maxLength={40}
                    style={{ width: 240 }}
                  />
                </FormRow>

                <FormRow
                  label="Talk frequency"
                  hint="How often the DJ speaks between tracks and at the top of each hour. Music selection is unaffected."
                >
                  <FrequencySegmented
                    value={form.dj.frequency}
                    onChange={v => setForm(f => ({ ...f, dj: { ...f.dj, frequency: v } }))}
                  />
                </FormRow>
                <Footnote>
                  {FREQUENCY_HINTS[form.dj.frequency]}
                </Footnote>

                <FormRow
                  label="Soul"
                  hint="Short personality description. Injected into the system prompt as {soul}."
                >
                  <textarea
                    rows={3}
                    value={form.dj.soul}
                    onChange={e => setForm(f => ({ ...f, dj: { ...f.dj, soul: e.target.value } }))}
                    maxLength={400}
                    className="w-full v3-focus"
                    style={{
                      boxSizing: 'border-box',
                      border: '1px solid var(--ink)',
                      background: 'transparent',
                      padding: 10,
                      fontSize: 13,
                      fontFamily: 'inherit',
                      color: 'var(--ink)',
                      resize: 'none',
                    }}
                  />
                </FormRow>
                <Footnote>
                  {form.dj.soul.length}/400 chars
                </Footnote>

                <details className="mt-3" style={{ border: '1px solid var(--ink)' }}>
                  <summary
                    className="cursor-pointer v3-caption"
                    style={{ padding: '8px 12px', color: 'var(--ink)' }}
                  >
                    System prompt template (advanced)
                  </summary>
                  <div style={{ padding: 12, borderTop: '1px solid var(--ink)' }}>
                    <Hint>
                      Placeholders: <code>{'{name}'}</code> · <code>{'{soul}'}</code> ·
                      {' '}<code>{'{station}'}</code> · <code>{'{location}'}</code>.
                      {' '}<code>{'{name}'}</code> is required.
                    </Hint>
                    <textarea
                      rows={10}
                      value={form.dj.systemPrompt}
                      onChange={e => setForm(f => ({ ...f, dj: { ...f.dj, systemPrompt: e.target.value } }))}
                      maxLength={4000}
                      className="w-full v3-focus mt-2"
                      style={{
                        boxSizing: 'border-box',
                        border: '1px solid var(--ink)',
                        background: 'transparent',
                        padding: 10,
                        fontSize: 12,
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        color: 'var(--ink)',
                        resize: 'vertical',
                        lineHeight: 1.5,
                      }}
                    />
                    <div className="flex items-center gap-2 mt-2">
                      <OutlineButton
                        onClick={() => setForm(f => ({
                          ...f,
                          dj: { ...f.dj, systemPrompt: data.defaults?.dj?.systemPrompt || '' },
                        }))}
                        disabled={busy || !data.defaults?.dj?.systemPrompt}
                      >
                        reset to default
                      </OutlineButton>
                      <span style={{ color: 'var(--muted)', fontSize: 11 }}>
                        {form.dj.systemPrompt.length}/4000 chars
                      </span>
                    </div>
                  </div>
                </details>

                <div
                  className="flex flex-wrap items-center gap-3 pt-3 mt-3"
                  style={{ borderTop: '1px solid var(--separator-strong)' }}
                >
                  <SolidButton
                    onClick={() => saveSettings({
                      dj: {
                        name: form.dj.name.trim(),
                        soul: form.dj.soul.trim(),
                        systemPrompt: form.dj.systemPrompt.trim(),
                        frequency: form.dj.frequency,
                      },
                    })}
                    disabled={busy}
                  >
                    save persona
                  </SolidButton>
                  {saveMsg && (
                    <span style={{ fontSize: 12, color: saveMsg.tone === 'err' ? '#c5302a' : 'var(--accent)' }}>
                      {saveMsg.text}
                    </span>
                  )}
                </div>
                <Footnote>
                  All persona changes apply live — no mixer restart needed.
                </Footnote>
              </Section>
            )}

            {form && (
              <Section title="Mixer settings">
                <div className="space-y-5">
                  <FormRow
                    label="Crossfade duration"
                    hint={`Seconds of overlap between tracks (current: ${data.values?.crossfadeDuration}s)`}
                    requiresRestart
                  >
                    <NumInput
                      value={form.crossfadeDuration}
                      onChange={e => setForm(f => ({ ...f, crossfadeDuration: e.target.value }))}
                      style={{ width: 112 }}
                      step={0.5}
                      max={30}
                    />
                    <span style={{ color: 'var(--muted)', fontSize: 12, marginLeft: 8 }}>sec</span>
                  </FormRow>

                  <FormRow
                    label="Weather location"
                    hint={`Used for DJ context + Open-Meteo lookups (current: ${data.values?.weather?.locationName} @ ${data.values?.weather?.lat}, ${data.values?.weather?.lng})`}
                  >
                    <div className="flex flex-wrap gap-2">
                      <TextInput
                        placeholder="name"
                        value={form.weather.locationName}
                        onChange={e => setForm(f => ({ ...f, weather: { ...f.weather, locationName: e.target.value } }))}
                        style={{ width: 176 }}
                      />
                      <NumInput
                        step="any"
                        placeholder="lat"
                        value={form.weather.lat}
                        onChange={e => setForm(f => ({ ...f, weather: { ...f.weather, lat: e.target.value } }))}
                        style={{ width: 128 }}
                      />
                      <NumInput
                        step="any"
                        placeholder="lng"
                        value={form.weather.lng}
                        onChange={e => setForm(f => ({ ...f, weather: { ...f.weather, lng: e.target.value } }))}
                        style={{ width: 128 }}
                      />
                    </div>
                  </FormRow>

                  <div
                    className="flex flex-wrap items-center gap-3 pt-3"
                    style={{ borderTop: '1px solid var(--separator-strong)' }}
                  >
                    <SolidButton
                      onClick={() => saveSettings({
                        crossfadeDuration: parseFloat(form.crossfadeDuration),
                        weather: {
                          lat: parseFloat(form.weather.lat),
                          lng: parseFloat(form.weather.lng),
                          locationName: form.weather.locationName,
                        },
                      })}
                      disabled={busy}
                    >
                      save settings
                    </SolidButton>
                    {pendingRestart && (
                      <SolidButton onClick={restartMixer} disabled={busy} danger>
                        restart mixer
                      </SolidButton>
                    )}
                    {saveMsg && (
                      <span style={{ fontSize: 12, color: saveMsg.tone === 'err' ? '#c5302a' : 'var(--accent)' }}>
                        {saveMsg.text}
                      </span>
                    )}
                  </div>
                  <Footnote>
                    Weather location applies live · Crossfade requires a mixer restart
                  </Footnote>
                </div>
              </Section>
            )}

            <Section title="Library mood tags">
              <Row>
                <div>
                  <Lead>
                    {data.libraryStats?.total ?? 0} tracks tagged
                    {data.libraryStats?.updatedAt && (
                      <span style={{ color: 'var(--muted)', marginLeft: 8, fontSize: 12 }}>
                        · last update {new Date(data.libraryStats.updatedAt).toLocaleString('en-GB')}
                      </span>
                    )}
                  </Lead>
                  <Hint>
                    Walks your Navidrome library album-by-album, classifies each track via Ollama.
                    Resumable — already-tagged tracks are skipped.
                  </Hint>
                </div>
              </Row>

              <div className="flex items-center gap-2 mt-3">
                <span className="v3-caption" style={{ color: 'var(--muted)' }}>limit</span>
                <NumInput
                  value={taggerLimit}
                  onChange={e => setTaggerLimit(e.target.value)}
                  disabled={data.tagger.running}
                  style={{ width: 96 }}
                />
                <SolidButton
                  onClick={startTagger}
                  disabled={busy || data.tagger.running}
                >
                  {data.tagger.running ? 'running…' : 'start tagging'}
                </SolidButton>
                {data.tagger.running && data.tagger.startedAt && (
                  <span style={{ color: 'var(--muted)', fontSize: 11 }}>
                    pid {data.tagger.pid} · started {new Date(data.tagger.startedAt).toLocaleTimeString('en-GB')}
                  </span>
                )}
              </div>

              {data.libraryStats?.total > 0 && (
                <div className="mt-4">
                  <div className="v3-caption mb-2" style={{ color: 'var(--muted)' }}>by mood</div>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(data.libraryStats.byMood || {})
                      .sort((a, b) => b[1] - a[1])
                      .map(([m, n]) => (
                        <span
                          key={m}
                          style={{
                            border: '1px solid var(--ink)',
                            padding: '2px 8px',
                            fontSize: 12,
                          }}
                        >
                          <span style={{ color: 'var(--ink)' }}>{m}</span>{' '}
                          <span className="v3-tab-num" style={{ color: 'var(--muted)' }}>{n}</span>
                        </span>
                      ))}
                  </div>
                </div>
              )}

              {data.tagger.lastLog?.length > 0 && (
                <details className="mt-4" style={{ border: '1px solid var(--ink)' }}>
                  <summary
                    className="cursor-pointer v3-caption"
                    style={{ padding: '8px 12px', color: 'var(--ink)' }}
                  >
                    tagger log ({data.tagger.lastLog.length} lines)
                  </summary>
                  <pre
                    className="v3-scroll"
                    style={{
                      fontSize: 11,
                      lineHeight: 1.4,
                      maxHeight: 280,
                      overflowY: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      padding: 12,
                      color: 'var(--ink)',
                      borderTop: '1px solid var(--ink)',
                    }}
                  >
                    {data.tagger.lastLog.join('\n')}
                  </pre>
                </details>
              )}
            </Section>

            <Section title={`Jingles · ${data.jingles.length}`}>
              <Hint>
                Pre-recorded TTS stingers. A default station ident is generated on first boot;
                you can add your own here.
              </Hint>

              {form && (
                <div
                  className="flex flex-wrap items-end gap-3 mt-4 pb-4"
                  style={{ borderBottom: '1px solid var(--separator-strong)' }}
                >
                  <div>
                    <div style={{ color: 'var(--ink)', fontSize: 13, fontWeight: 600 }}>
                      Frequency
                    </div>
                    <Hint>1 jingle every N music tracks · current: {data.values?.jingleRatio}</Hint>
                  </div>
                  <NumInput
                    value={form.jingleRatio}
                    onChange={e => setForm(f => ({ ...f, jingleRatio: e.target.value }))}
                    style={{ width: 96 }}
                    min={1}
                    max={1000}
                  />
                  <SolidButton
                    onClick={() => saveSettings({ jingleRatio: parseInt(form.jingleRatio, 10) })}
                    disabled={busy || form.jingleRatio === String(data.values?.jingleRatio)}
                  >
                    save · needs restart
                  </SolidButton>
                </div>
              )}

              <div className="space-y-2 mt-3">
                <textarea
                  rows={2}
                  value={jingleText}
                  onChange={e => setJingleText(e.target.value)}
                  placeholder='e.g. "You are listening to SUB slash WAVE. Requests open all night."'
                  className="w-full v3-focus"
                  style={{
                    boxSizing: 'border-box',
                    border: '1px solid var(--ink)',
                    background: 'transparent',
                    padding: 10,
                    fontSize: 13,
                    fontFamily: 'inherit',
                    color: 'var(--ink)',
                    resize: 'none',
                  }}
                />
                <div className="flex items-center gap-2">
                  <SolidButton onClick={createJingle} disabled={busy || !jingleText.trim()}>
                    {busy ? 'generating…' : 'create jingle'}
                  </SolidButton>
                  <span style={{ color: 'var(--muted)', fontSize: 11 }}>
                    {jingleText.length}/500 chars · Piper TTS
                  </span>
                </div>
              </div>

              <div className="mt-5" style={{ borderTop: '1px solid var(--separator-strong)' }}>
                {data.jingles.length === 0 && (
                  <div className="py-4 italic" style={{ color: 'var(--muted)', fontSize: 12 }}>none yet</div>
                )}
                {data.jingles.map(j => (
                  <div
                    key={j.filename}
                    className="py-3 flex items-start gap-3"
                    style={{ borderBottom: '1px solid var(--separator-soft)' }}
                  >
                    <div className="flex-1 min-w-0">
                      <div style={{ color: 'var(--ink)' }} className="break-words">{j.text}</div>
                      <div className="mt-1 flex flex-wrap gap-3 v3-caption" style={{ color: 'var(--muted)' }}>
                        <span>{j.filename}</span>
                        <span>{fmtSize(j.size)}</span>
                        {j.createdAt && <span>{new Date(j.createdAt).toLocaleString('en-GB')}</span>}
                        {j.builtin && <span style={{ color: 'var(--accent)' }}>builtin</span>}
                      </div>
                    </div>
                    <OutlineButton
                      onClick={() => deleteJingle(j.filename)}
                      disabled={busy || j.builtin}
                      title={j.builtin ? "Can't delete the built-in ident" : 'Delete this jingle'}
                    >
                      delete
                    </OutlineButton>
                  </div>
                ))}
              </div>
            </Section>

            <div className="flex justify-center items-center gap-3 pt-2">
              <a
                href="/debug"
                target="_blank"
                rel="noopener noreferrer"
                className="v3-eyebrow v3-focus"
                style={{
                  border: '1px solid var(--ink)',
                  color: 'var(--ink)',
                  padding: '8px 16px',
                  fontSize: 10,
                  textDecoration: 'none',
                }}
              >
                open debug ↗
              </a>
              {auth && (
                <OutlineButton
                  onClick={() => {
                    try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch {}
                    setAuth(null);
                    setData(null);
                    setForm(null);
                    setNeedsAuth(true);
                  }}
                >
                  sign out
                </OutlineButton>
              )}
            </div>
          </>
        )}
      </div>
    </FullDialog>
  );
}

function Section({ title, children }) {
  return (
    <section style={{ border: '1px solid var(--ink)' }}>
      <div className="px-4 py-2" style={{ borderBottom: '1px solid var(--ink)' }}>
        <span className="v3-eyebrow" style={{ fontSize: 11 }}>{title}</span>
      </div>
      <div className="p-5 space-y-2">{children}</div>
    </section>
  );
}
function Row({ children }) {
  return <div className="flex items-start justify-between gap-4 py-2">{children}</div>;
}
function FormRow({ label, hint, requiresRestart, children }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span style={{ color: 'var(--ink)', fontSize: 14, fontWeight: 600 }}>{label}</span>
        {requiresRestart && (
          <span
            className="v3-caption"
            style={{ fontSize: 9, border: '1px solid var(--ink)', padding: '1px 6px' }}
          >
            restart required
          </span>
        )}
      </div>
      {hint && <Hint>{hint}</Hint>}
      <div className="flex items-center flex-wrap">{children}</div>
    </div>
  );
}
function Lead({ children }) {
  return <div style={{ color: 'var(--ink)', fontSize: 14, fontWeight: 600 }}>{children}</div>;
}
function Hint({ children }) {
  return <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5, marginTop: 4 }}>{children}</div>;
}
function Footnote({ children }) {
  return <div className="v3-caption mt-3" style={{ color: 'var(--muted)' }}>{children}</div>;
}
function KV({ k, v }) {
  return (
    <div className="flex gap-2">
      <span className="v3-caption shrink-0" style={{ color: 'var(--muted)', width: 128 }}>{k}</span>
      <span style={{ color: 'var(--ink)' }} className="break-all">{v}</span>
    </div>
  );
}
function SolidButton({ onClick, disabled, danger, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="v3-eyebrow v3-focus cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      style={{
        background: danger ? '#c5302a' : 'var(--accent)',
        color: '#fff',
        border: 'none',
        padding: '8px 16px',
        fontSize: 10,
      }}
    >
      {children}
    </button>
  );
}
function OutlineButton({ onClick, disabled, title, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="v3-eyebrow v3-focus cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
      style={{
        background: 'transparent',
        color: 'var(--ink)',
        border: '1px solid var(--ink)',
        padding: '4px 10px',
        fontSize: 10,
      }}
    >
      {children}
    </button>
  );
}
function TextInput(props) {
  return (
    <input
      type="text"
      {...props}
      className="v3-focus"
      style={{
        boxSizing: 'border-box',
        border: '1px solid var(--ink)',
        background: 'transparent',
        padding: '8px 12px',
        fontSize: 13,
        fontFamily: 'inherit',
        color: 'var(--ink)',
        outline: 'none',
        ...(props.style || {}),
      }}
    />
  );
}
function NumInput({ style, ...props }) {
  return (
    <input
      type="number"
      {...props}
      className="v3-focus v3-tab-num"
      style={{
        boxSizing: 'border-box',
        border: '1px solid var(--ink)',
        background: 'transparent',
        padding: '8px 12px',
        fontSize: 13,
        fontFamily: 'inherit',
        color: 'var(--ink)',
        outline: 'none',
        ...(style || {}),
      }}
    />
  );
}
function FrequencySegmented({ value, onChange }) {
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--ink)' }}>
      {FREQUENCIES.map((m, i) => {
        const active = value === m;
        return (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            className="v3-eyebrow v3-focus cursor-pointer"
            style={{
              background: active ? 'var(--ink)' : 'transparent',
              color: active ? 'var(--bg)' : 'var(--ink)',
              border: 'none',
              borderLeft: i === 0 ? 'none' : '1px solid var(--ink)',
              padding: '8px 14px',
              fontSize: 10,
            }}
            aria-pressed={active}
          >
            {m}
          </button>
        );
      })}
    </div>
  );
}

function ThemeSegmented({ value, onChange }) {
  const labels = { system: 'system', light: 'light', dark: 'dark' };
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--ink)' }}>
      {THEME_MODES.map((m, i) => {
        const active = value === m;
        return (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            className="v3-eyebrow v3-focus cursor-pointer"
            style={{
              background: active ? 'var(--ink)' : 'transparent',
              color: active ? 'var(--bg)' : 'var(--ink)',
              border: 'none',
              borderLeft: i === 0 ? 'none' : '1px solid var(--ink)',
              padding: '8px 14px',
              fontSize: 10,
            }}
            aria-pressed={active}
          >
            {labels[m]}
          </button>
        );
      })}
    </div>
  );
}

function SignInForm({ onSubmit }) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');

  const submit = (e) => {
    e?.preventDefault?.();
    if (!user || !pass) return;
    onSubmit(user, pass);
  };

  return (
    <form onSubmit={submit} style={{ border: '1px solid var(--ink)' }}>
      <div className="px-4 py-2" style={{ borderBottom: '1px solid var(--ink)' }}>
        <span className="v3-eyebrow" style={{ fontSize: 11 }}>Sign in</span>
      </div>
      <div className="p-5 space-y-3">
        <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
          The controller requires admin credentials for these settings.
          They're cached in this browser only.
        </div>
        <input
          type="text"
          autoComplete="username"
          placeholder="username"
          value={user}
          onChange={e => setUser(e.target.value)}
          className="w-full v3-focus"
          style={{
            boxSizing: 'border-box',
            border: '1px solid var(--ink)',
            background: 'transparent',
            padding: 10,
            fontSize: 13,
            fontFamily: 'inherit',
            color: 'var(--ink)',
          }}
          autoFocus
        />
        <input
          type="password"
          autoComplete="current-password"
          placeholder="password"
          value={pass}
          onChange={e => setPass(e.target.value)}
          className="w-full v3-focus"
          style={{
            boxSizing: 'border-box',
            border: '1px solid var(--ink)',
            background: 'transparent',
            padding: 10,
            fontSize: 13,
            fontFamily: 'inherit',
            color: 'var(--ink)',
          }}
        />
        <button
          type="submit"
          disabled={!user || !pass}
          className="v3-eyebrow v3-focus cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            background: 'var(--accent)',
            color: '#fff',
            border: 'none',
            padding: '10px 20px',
            fontSize: 10,
          }}
        >
          sign in
        </button>
      </div>
    </form>
  );
}

function Alert({ tone, children }) {
  return (
    <div
      style={{
        border: `1px solid ${tone === 'err' ? '#c5302a' : 'var(--ink)'}`,
        color: tone === 'err' ? '#c5302a' : 'var(--ink)',
        padding: '8px 12px',
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}
