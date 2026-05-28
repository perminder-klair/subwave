'use client';

// Selection rules — /admin/rules. Two modes share one list:
//   exclude       — filters the picker's candidate pool by genre/artist/
//                   album/playlist source.
//   force-insert  — periodically jams a track from a Navidrome playlist or
//                   album into the broadcast, either every N tracks
//                   (Liquidsoap-side, deterministic) or every N minutes
//                   (controller-side, with optional jitter).
// See controller/src/broadcast/rule-engine.ts + liquidsoap/radio.liq for the
// execution paths.

import { useEffect, useMemo, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { notify, errorMessage } from '../../lib/notify';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Card, Btn, Pill, Eyebrow, Toggle } from './ui';

type Mode = 'exclude' | 'force-insert';
type SourceKind = 'playlist' | 'genre' | 'artist' | 'album';
type CadenceKind = 'every-n-tracks' | 'every-n-minutes';
type PickStrategy = 'random' | 'least-recently-played';
type DjBehavior = 'silent' | 'announce';

interface Cadence {
  kind: CadenceKind;
  value: number;
  jitter?: number;
}

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  mode: Mode;
  source: { kind: SourceKind; ref: string };
  cadence?: Cadence;
  pickStrategy?: PickStrategy;
  djBehavior?: DjBehavior;
  announceText?: string;
}

interface RulesResponse {
  rules: Rule[];
  modes: Mode[];
  sourceKinds: SourceKind[];
  forceInsertSourceKinds: SourceKind[];
  cadenceKinds: CadenceKind[];
  pickStrategies: PickStrategy[];
  djBehaviors: DjBehavior[];
  limits: { max: number; trackSlotCap: number };
}

const WEIGHT_SCALE = 1000;

function clientMintId() {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return 'r_' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function blankExclude(): Rule {
  return {
    id: clientMintId(),
    name: 'Exclude genre',
    enabled: true,
    mode: 'exclude',
    source: { kind: 'genre', ref: '' },
  };
}

function blankForceInsert(): Rule {
  return {
    id: clientMintId(),
    name: 'Hourly insert',
    enabled: true,
    mode: 'force-insert',
    source: { kind: 'playlist', ref: '' },
    cadence: { kind: 'every-n-minutes', value: 60, jitter: 10 },
    pickStrategy: 'random',
    djBehavior: 'silent',
  };
}

function valid(r: Rule): boolean {
  if (!r.source?.ref) return false;
  if (r.mode === 'force-insert') {
    if (!r.cadence?.kind) return false;
    if (!Number.isFinite(r.cadence.value) || r.cadence.value < 1) return false;
    if (r.djBehavior === 'announce' && !(r.announceText || '').trim()) return false;
  }
  return true;
}

function trackSlotCount(rules: Rule[]): number {
  return rules.filter(
    r => r.enabled && r.mode === 'force-insert' && r.cadence?.kind === 'every-n-tracks',
  ).length;
}

function actualCadenceLabel(rules: Rule[], rule: Rule): string | null {
  if (rule.mode !== 'force-insert' || rule.cadence?.kind !== 'every-n-tracks') return null;
  // Mirrors controller/src/broadcast/rule-weights.ts: compute integer weights
  // for all enabled track-counted rules; total = base + Σweights; per-rule
  // cadence ≈ total / w.
  const trackRules = rules.filter(
    r => r.enabled && r.mode === 'force-insert' && r.cadence?.kind === 'every-n-tracks',
  );
  const weights = trackRules.map(r => Math.max(1, Math.round(WEIGHT_SCALE / (r.cadence?.value || 1))));
  const sum = weights.reduce((a, b) => a + b, 0);
  const base = Math.max(1, WEIGHT_SCALE - sum);
  const idx = trackRules.findIndex(r => r.id === rule.id);
  if (idx < 0) return null;
  const w = weights[idx];
  if (!w) return null;
  const total = base + sum;
  const actual = Math.round((total / w) * 10) / 10;
  return `≈ every ${actual} tracks`;
}

export default function RulesPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [meta, setMeta] = useState<RulesResponse | null>(null);
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Autocomplete data — fetched lazily per source kind. Stored as a lookup
  // table so reopens reuse the prior fetch.
  const [genres, setGenres] = useState<{ value: string; songCount?: number }[] | null>(null);
  const [playlists, setPlaylists] = useState<{ id: string; name: string }[] | null>(null);

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch('/rules');
        if (!r.ok) throw new Error(`failed (${r.status})`);
        const j = (await r.json()) as RulesResponse;
        if (cancelled) return;
        setMeta(j);
        setRules(j.rules || []);
      } catch (e) {
        if (!cancelled) setErr(errorMessage(e));
      }
    })();
    return () => { cancelled = true; };
  }, [hydrated, needsAuth, adminFetch]);

  const loadGenres = async () => {
    if (genres) return;
    try {
      const r = await adminFetch('/library/genres');
      const j = await r.json();
      setGenres(j.genres || []);
    } catch (e) {
      notify.err(`Genres: ${errorMessage(e)}`);
    }
  };
  const loadPlaylists = async () => {
    if (playlists) return;
    try {
      const r = await adminFetch('/library/playlists');
      const j = await r.json();
      setPlaylists(j.playlists || []);
    } catch (e) {
      notify.err(`Playlists: ${errorMessage(e)}`);
    }
  };

  const save = async (next: Rule[]) => {
    setBusy(true);
    try {
      const r = await adminFetch('/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: next }),
      });
      const j = (await r.json().catch(() => ({}))) as { rules?: Rule[]; error?: string; requiresRestart?: boolean };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setRules(j.rules || []);
      notify.ok(j.requiresRestart ? 'Rules saved — mixer will restart.' : 'Rules saved.');
    } catch (e) {
      notify.err(`Save failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const testRule = async (rule: Rule) => {
    try {
      const r = await adminFetch('/rules/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      if (rule.mode === 'exclude') {
        notify.ok(`Matches ${j.matched} tracks${j.sample?.length ? ` — e.g. ${j.sample.slice(0, 3).map((s: any) => `${s.title} (${s.artist})`).join(', ')}` : ''}.`);
      } else {
        const picks = (j.picks || []).map((p: any) => `${p.title} (${p.artist})`).join(', ');
        notify.ok(picks ? `Next picks: ${picks}` : 'Source resolved to 0 tracks.');
      }
    } catch (e) {
      notify.err(`Test failed: ${errorMessage(e)}`);
    }
  };

  const allValid = useMemo(() => (rules || []).every(valid), [rules]);

  if (err) {
    return (
      <div className="grid gap-4">
        <Card title="Rules"><div className="text-[13px] text-[var(--danger)]">controller error: {err}</div></Card>
      </div>
    );
  }
  if (!rules || !meta) {
    return (
      <div className="grid gap-4">
        <Card title="Rules"><div className="text-[13px] text-muted italic">loading…</div></Card>
      </div>
    );
  }

  const trackSlots = trackSlotCount(rules);
  const trackCapReached = trackSlots >= meta.limits.trackSlotCap;

  return (
    <div className="grid gap-4">
      <section className="card">
        <div className="border-b border-ink p-4">
          <Eyebrow className="text-vermilion">selection rules</Eyebrow>
          <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
            Filter the picker pool or force tracks in on a cadence.
          </div>
          <div className="mt-1 text-[11px] leading-[1.6] text-muted">
            <strong>Exclude</strong> rules drop tracks from the picker before it can choose them (e.g. block Christmas / classical).{' '}
            <strong>Force-insert</strong> rules play a track from a Navidrome playlist or album every N tracks or every N minutes —
            for hourly idents, sponsor reads, story vignettes. Up to {meta.limits.trackSlotCap} track-counted force-insert rules
            can be active at once; minute-counted rules are unlimited.
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 bg-[var(--ink-softer)] p-3.5">
          <span className="caption">{rules.length} rule{rules.length === 1 ? '' : 's'}</span>
          <span className="caption text-vermilion">
            {rules.filter(r => r.enabled).length} enabled
          </span>
          <span className="caption">
            track slots: {trackSlots}/{meta.limits.trackSlotCap}
          </span>
          <span className="ml-auto" />
          <Btn sm onClick={() => setRules([...rules, blankExclude()])} disabled={rules.length >= meta.limits.max}>
            + Exclude
          </Btn>
          <Btn sm onClick={() => setRules([...rules, blankForceInsert()])} disabled={rules.length >= meta.limits.max}>
            + Force-insert
          </Btn>
          <Btn sm tone="accent" onClick={() => save(rules)} disabled={!allValid || busy}>
            {busy ? 'Saving…' : 'Save'}
          </Btn>
        </div>
      </section>

      {rules.length === 0 && (
        <Card title="No rules yet">
          <div className="text-[12px] leading-[1.6] text-muted">
            Add an exclude rule to drop a genre or artist from rotation, or a force-insert to schedule
            periodic clips from a Navidrome playlist.
          </div>
        </Card>
      )}

      {rules.map((r, i) => {
        const update = (patch: Partial<Rule>) => {
          const next = [...rules];
          next[i] = { ...r, ...patch };
          setRules(next);
        };
        const remove = () => setRules(rules.filter((_, j) => j !== i));
        const cadenceLabel = actualCadenceLabel(rules, r);

        const sourceKinds = r.mode === 'force-insert'
          ? meta.forceInsertSourceKinds
          : meta.sourceKinds;

        return (
          <Card
            key={r.id}
            title={r.name || <span className="text-muted italic">(new rule)</span>}
            right={
              <>
                <Pill tone={r.mode === 'exclude' ? 'default' : 'accent'} dot>
                  {r.mode}
                </Pill>
                <Toggle on={r.enabled} onClick={() => update({ enabled: !r.enabled })} />
              </>
            }
          >
            <div className="grid gap-3">
              <div>
                <Label className="caption">Name</Label>
                <Input
                  value={r.name}
                  onChange={e => update({ name: e.target.value })}
                  maxLength={80}
                />
              </div>

              <div className="grid gap-2 sm:grid-cols-[140px_1fr]">
                <div>
                  <Label className="caption">Source</Label>
                  <select
                    className="mt-1 w-full rounded border border-ink bg-[var(--ink-softer)] px-2 py-1.5 text-[12px]"
                    value={r.source.kind}
                    onChange={e => {
                      const kind = e.target.value as SourceKind;
                      update({ source: { kind, ref: '' } });
                      if (kind === 'genre') loadGenres();
                      if (kind === 'playlist') loadPlaylists();
                    }}
                  >
                    {sourceKinds.map(k => <option key={k} value={k}>{k}</option>)}
                  </select>
                </div>
                <div>
                  <Label className="caption">
                    {r.source.kind === 'genre' ? 'Genre name' :
                     r.source.kind === 'playlist' ? 'Playlist' :
                     r.source.kind === 'artist' ? 'Artist id or name' :
                     'Album id'}
                  </Label>
                  {r.source.kind === 'genre' && genres ? (
                    <select
                      className="mt-1 w-full rounded border border-ink bg-[var(--ink-softer)] px-2 py-1.5 text-[12px]"
                      value={r.source.ref}
                      onChange={e => update({ source: { ...r.source, ref: e.target.value } })}
                    >
                      <option value="">— pick a genre —</option>
                      {genres.map(g => (
                        <option key={g.value} value={g.value}>
                          {g.value}{g.songCount ? ` (${g.songCount})` : ''}
                        </option>
                      ))}
                    </select>
                  ) : r.source.kind === 'playlist' && playlists ? (
                    <select
                      className="mt-1 w-full rounded border border-ink bg-[var(--ink-softer)] px-2 py-1.5 text-[12px]"
                      value={r.source.ref}
                      onChange={e => update({ source: { ...r.source, ref: e.target.value } })}
                    >
                      <option value="">— pick a playlist —</option>
                      {playlists.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      value={r.source.ref}
                      placeholder={
                        r.source.kind === 'artist' ? 'e.g. Karan Aujla or AR-1234' :
                        r.source.kind === 'album' ? 'e.g. AL-9001' :
                        ''
                      }
                      onFocus={() => {
                        if (r.source.kind === 'genre') loadGenres();
                        if (r.source.kind === 'playlist') loadPlaylists();
                      }}
                      onChange={e => update({ source: { ...r.source, ref: e.target.value } })}
                    />
                  )}
                </div>
              </div>

              {r.mode === 'force-insert' && r.cadence && (
                <>
                  <div className="grid gap-2 sm:grid-cols-[160px_140px_1fr]">
                    <div>
                      <Label className="caption">Cadence</Label>
                      <select
                        className="mt-1 w-full rounded border border-ink bg-[var(--ink-softer)] px-2 py-1.5 text-[12px]"
                        value={r.cadence.kind}
                        onChange={e => {
                          const kind = e.target.value as CadenceKind;
                          const value = kind === 'every-n-tracks' ? 7 : 60;
                          const jitter = kind === 'every-n-minutes' ? 10 : undefined;
                          update({ cadence: { kind, value, jitter } });
                        }}
                      >
                        {meta.cadenceKinds.map(k => <option key={k} value={k}>{k}</option>)}
                      </select>
                    </div>
                    <div>
                      <Label className="caption">Every</Label>
                      <Input
                        type="number"
                        min={1}
                        max={r.cadence.kind === 'every-n-tracks' ? 1000 : 720}
                        value={r.cadence.value}
                        onChange={e => update({
                          cadence: { ...r.cadence!, value: parseInt(e.target.value, 10) || 1 },
                        })}
                      />
                    </div>
                    <div className="self-end pb-1.5">
                      <span className="text-[11px] text-muted">
                        {r.cadence.kind === 'every-n-tracks' ? 'music tracks' : 'minutes'}
                        {cadenceLabel && <> · <span className="text-vermilion">{cadenceLabel}</span></>}
                      </span>
                    </div>
                  </div>

                  {r.cadence.kind === 'every-n-minutes' && (
                    <div className="grid gap-2 sm:grid-cols-[160px_140px_1fr]">
                      <div className="sm:col-start-2">
                        <Label className="caption">Jitter ±%</Label>
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          value={r.cadence.jitter ?? 10}
                          onChange={e => update({
                            cadence: { ...r.cadence!, jitter: parseInt(e.target.value, 10) || 0 },
                          })}
                        />
                      </div>
                      <div className="self-end pb-1.5 text-[11px] text-muted">
                        0 = exact clockwork; 10% smooths a bus-timetable feel.
                      </div>
                    </div>
                  )}

                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <Label className="caption">Pick strategy</Label>
                      <select
                        className="mt-1 w-full rounded border border-ink bg-[var(--ink-softer)] px-2 py-1.5 text-[12px]"
                        value={r.pickStrategy || 'random'}
                        onChange={e => update({ pickStrategy: e.target.value as PickStrategy })}
                      >
                        {meta.pickStrategies.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div>
                      <Label className="caption">DJ behaviour</Label>
                      <select
                        className="mt-1 w-full rounded border border-ink bg-[var(--ink-softer)] px-2 py-1.5 text-[12px]"
                        value={r.djBehavior || 'silent'}
                        onChange={e => update({ djBehavior: e.target.value as DjBehavior })}
                      >
                        {meta.djBehaviors.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                  </div>

                  {r.djBehavior === 'announce' && (
                    <div>
                      <Label className="caption">Announce text</Label>
                      <Input
                        value={r.announceText || ''}
                        placeholder='e.g. "Quick word from our sponsors."'
                        maxLength={400}
                        onChange={e => update({ announceText: e.target.value })}
                      />
                      <div className="mt-1 text-[10px] text-muted">
                        Spoken verbatim before the rule track lands. Persona voice; no LLM ad-lib.
                      </div>
                    </div>
                  )}
                </>
              )}

              <div className="mt-1 flex items-center gap-2">
                <Btn sm tone="accent" onClick={() => testRule(r)} disabled={!valid(r)}>
                  Test
                </Btn>
                <span className="ml-auto" />
                <Btn sm tone="danger" onClick={remove}>Remove</Btn>
              </div>
            </div>
          </Card>
        );
      })}

      {trackCapReached && (
        <Card title="Track-slot cap reached">
          <div className="text-[11px] leading-[1.6] text-muted">
            You've used all {meta.limits.trackSlotCap} track-counted slots. Convert another to
            minute-counted, or disable one, to add more.
          </div>
        </Card>
      )}
    </div>
  );
}
