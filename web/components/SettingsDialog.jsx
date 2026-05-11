'use client';

import { useEffect, useState } from 'react';
import { FullDialog } from './ui/dialog';
import { V3Switch } from './ui/switch';
import { fmtSize } from '../lib/format';
import { getStoredTheme, setTheme, THEME_MODES } from '../lib/theme';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

export default function SettingsDialog({ open, onOpenChange }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [jingleText, setJingleText] = useState('');
  const [taggerLimit, setTaggerLimit] = useState('50');
  const [form, setForm] = useState(null);
  const [pendingRestart, setPendingRestart] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [themeMode, setThemeMode] = useState('system');

  useEffect(() => { setThemeMode(getStoredTheme()); }, []);

  const pickTheme = (m) => { setTheme(m); setThemeMode(m); };

  const refresh = async () => {
    try {
      const r = await fetch(`${API_URL}/settings`);
      const j = await r.json();
      setData(j); setErr(null);
      if (!form && j.values) {
        setForm({
          jingleRatio: String(j.values.jingleRatio),
          crossfadeDuration: String(j.values.crossfadeDuration),
          weather: {
            ...j.values.weather,
            lat: String(j.values.weather.lat),
            lng: String(j.values.weather.lng),
          },
        });
      }
    } catch (e) { setErr(e.message); }
  };

  useEffect(() => {
    if (!open) return;
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const saveSettings = async (patch) => {
    setBusy(true); setSaveMsg(null);
    try {
      const r = await fetch(`${API_URL}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
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
      const r = await fetch(`${API_URL}/restart-mixer`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
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
      const r = await fetch(`${API_URL}/jingles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: jingleText.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      setJingleText('');
      await refresh();
    } catch (e) { alert(`Jingle creation failed: ${e.message}`); }
    finally { setBusy(false); }
  };

  const deleteJingle = async (filename) => {
    if (!confirm(`Delete ${filename}?`)) return;
    setBusy(true);
    try {
      const r = await fetch(`${API_URL}/jingles/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      await refresh();
    } catch (e) { alert(`Delete failed: ${e.message}`); }
    finally { setBusy(false); }
  };

  const toggleAutoPick = async () => {
    if (!data) return;
    setBusy(true);
    try {
      await fetch(`${API_URL}/auto-pick`, {
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
      const r = await fetch(`${API_URL}/tag-library`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      await refresh();
    } catch (e) { alert(`Tagger start failed: ${e.message}`); }
    finally { setBusy(false); }
  };

  return (
    <FullDialog open={open} onOpenChange={onOpenChange} title="Settings">
      <div className="max-w-3xl mx-auto space-y-7">
        {err && <Alert tone="err">controller error: {err}</Alert>}
        {!data && !err && <div style={{ color: 'var(--muted)' }} className="italic">loading…</div>}

        {data && (
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
                Pre-recorded TTS stingers. One plays for every ~30 music tracks. A default station ident is
                generated on first boot; you can add your own here.
              </Hint>

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

            {form && (
              <Section title="Mixer settings">
                <div className="space-y-5">
                  <FormRow
                    label="Jingle frequency"
                    hint={`1 jingle every N music tracks (current: ${data.values?.jingleRatio})`}
                    requiresRestart
                  >
                    <NumInput
                      value={form.jingleRatio}
                      onChange={e => setForm(f => ({ ...f, jingleRatio: e.target.value }))}
                      style={{ width: 112 }}
                    />
                  </FormRow>

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
                        jingleRatio: parseInt(form.jingleRatio, 10),
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
                    Weather location applies live · Jingle freq + crossfade require a mixer restart
                  </Footnote>
                </div>
              </Section>
            )}

            <Section title="System">
              <div className="grid sm:grid-cols-2 gap-2 text-xs">
                <KV k="Ollama" v={`${data.ollama.model} @ ${data.ollama.url}`} />
                <KV k="Weather location" v={data.values?.weather?.locationName} />
              </div>
              <Hint>
                DJ persona prompt and voice file are still code-level edits — change <code>ollama.js</code>
                {' '}DJ_SYSTEM and the Piper voice in <code>.env</code>.
              </Hint>
            </Section>
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
