/* ============================================================================
   SUB/WAVE — Library Observatory · right-rail panels
   Ported from the prototype's panels.jsx. StatsView aggregates recompute from
   the filtered set; the Dossier renders one inspected track — header/strip from
   the in-hand node (instant), enrichment + embeddings + mix-next from the lazy
   detail fetch. Embedding fingerprints use the real learned vectors when the
   server returns them, falling back to a deterministic seed otherwise.
   ============================================================================ */
'use client';

import { useMemo, useState } from 'react';
import {
  heat,
  tally,
  arcPath,
  embeddingVector,
  normaliseFingerprint,
  keyRangeColor,
  loudnessToVal,
  CAMELOT_KEYS,
  type ObsTrack,
  type ObservatoryStats,
  type TrackDetail,
} from './data';

// ---- small primitives ------------------------------------------------------
function Bar({ label, value, max, accent }: { label: string; value: number; max: number; accent?: boolean }) {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return (
    <div className="obs-bar">
      <span className="obs-bar-l">{label}</span>
      <span className="obs-bar-track">
        <span className="obs-bar-fill" style={{ width: pct + '%', background: accent ? 'var(--accent)' : 'var(--ink)' }} />
      </span>
      <span className="obs-bar-n t-nums">{value}</span>
    </div>
  );
}

export function Card({
  title,
  sub,
  right,
  children,
  flush,
}: {
  title: string;
  sub?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  flush?: boolean;
}) {
  return (
    <div className="ad-card obs-card">
      <div className="ad-card-head">
        <span className="ad-card-title">{title}</span>
        {sub && <span className="ad-card-sub">{sub}</span>}
        {right && <span className="ad-card-right">{right}</span>}
      </div>
      <div className={'ad-card-body' + (flush ? ' flush' : '')}>{children}</div>
    </div>
  );
}

// ---- Camelot key wheel -----------------------------------------------------
function KeyWheel({ list }: { list: ObsTrack[] }) {
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    CAMELOT_KEYS.forEach((k) => (m[k] = 0));
    list.forEach((t) => {
      if (t.musicalKey != null && m[t.musicalKey] != null) m[t.musicalKey] = (m[t.musicalKey] ?? 0) + 1;
    });
    return m;
  }, [list]);
  const max = Math.max(1, ...Object.values(counts));
  const cx = 130;
  const cy = 130;
  const R0 = 44;
  const R1 = 86;
  const R2 = 124;
  const seg = (Math.PI * 2) / 12;
  const [hover, setHover] = useState<{ key: string; n: number } | null>(null);

  const ring = (r0: number, r1: number, suffix: string) =>
    Array.from({ length: 12 }, (_, i) => {
      const n = i + 1;
      const key = n + suffix;
      const a0 = -Math.PI / 2 + (i - 0.5) * seg;
      const a1 = a0 + seg;
      const v = (counts[key] ?? 0) / max;
      const op = 0.08 + v * 0.92;
      return (
        <path
          key={key}
          d={arcPath(cx, cy, r0, r1, a0, a1)}
          fill={counts[key] ? 'var(--accent)' : 'var(--field)'}
          fillOpacity={counts[key] ? op : 1}
          stroke="var(--ink)"
          strokeWidth="0.6"
          onMouseEnter={() => setHover({ key, n: counts[key] ?? 0 })}
          onMouseLeave={() => setHover(null)}
          style={{ cursor: 'default', transition: 'fill-opacity .2s' }}
        />
      );
    });

  return (
    <div className="keywheel-wrap">
      <svg viewBox="0 0 260 260" className="keywheel">
        {ring(R0, R1, 'A')}
        {ring(R1, R2, 'B')}
        {Array.from({ length: 12 }, (_, i) => {
          const a = -Math.PI / 2 + i * seg;
          const x = cx + (R2 + 9) * Math.cos(a);
          const y = cy + (R2 + 9) * Math.sin(a);
          return (
            <text key={i} x={x} y={y + 3} textAnchor="middle" className="kw-num">
              {i + 1}
            </text>
          );
        })}
        <text x={cx} y={cy - 4} textAnchor="middle" className="kw-c1">
          {hover ? hover.key : 'KEY'}
        </text>
        <text x={cx} y={cy + 12} textAnchor="middle" className="kw-c2">
          {hover ? hover.n + ' TRK' : 'WHEEL'}
        </text>
      </svg>
      <div className="kw-legend t-caption ad-muted">INNER · A (MINOR) — OUTER · B (MAJOR)</div>
    </div>
  );
}

// ---- BPM histogram (tempo river) -------------------------------------------
function TempoRiver({ list }: { list: ObsTrack[] }) {
  const bins = useMemo(() => {
    const edges = [60, 80, 90, 100, 110, 120, 128, 140, 160, 200];
    const b = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1] ?? Infinity, n: 0 }));
    list.forEach((t) => {
      if (t.bpm == null) return;
      for (const bin of b)
        if (t.bpm >= bin.lo && t.bpm < bin.hi) {
          bin.n++;
          break;
        }
    });
    return b;
  }, [list]);
  const max = Math.max(1, ...bins.map((b) => b.n));
  return (
    <div className="tempo-river">
      <div className="tr-bars">
        {bins.map((b, i) => (
          <div key={i} className="tr-col" title={`${b.lo}–${b.hi} BPM · ${b.n}`}>
            <div className="tr-bar" style={{ height: Math.round((b.n / max) * 100) + '%' }} />
            <span className="tr-x t-nums">{b.lo}</span>
          </div>
        ))}
      </div>
      <div className="t-caption ad-muted" style={{ marginTop: 6 }}>
        BEATS PER MINUTE →
      </div>
    </div>
  );
}

// ---- Loudness histogram (integrated LUFS) ----------------------------------
function LoudnessRiver({ list }: { list: ObsTrack[] }) {
  const bins = useMemo(() => {
    // Lower edges, in LUFS. Quieter masters on the left, hotter on the right.
    const edges = [-Infinity, -24, -18, -14, -10, -6, Infinity];
    const labels = ['≤−24', '−24', '−18', '−14', '−10', '−6'];
    const b = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1] ?? Infinity, label: labels[i] ?? '', n: 0 }));
    list.forEach((t) => {
      if (t.loudnessLufs == null) return;
      for (const bin of b)
        if (t.loudnessLufs >= bin.lo && t.loudnessLufs < bin.hi) {
          bin.n++;
          break;
        }
    });
    return b;
  }, [list]);
  const max = Math.max(1, ...bins.map((b) => b.n));
  return (
    <div className="tempo-river">
      <div className="tr-bars">
        {bins.map((b, i) => (
          <div key={i} className="tr-col" title={`${b.label} LUFS · ${b.n}`}>
            <div className="tr-bar" style={{ height: Math.round((b.n / max) * 100) + '%' }} />
            <span className="tr-x t-nums">{b.label}</span>
          </div>
        ))}
      </div>
      <div className="t-caption ad-muted" style={{ marginTop: 6 }}>
        INTEGRATED LOUDNESS (LUFS) →
      </div>
    </div>
  );
}

// ---- Song shape — per-track acoustic timeline ------------------------------
// One shared time axis (0…duration) across three lanes: the pace curve (with
// structural section boundaries + the intro marker), the vocal-presence lane,
// and the key bands. Positions are percent-based HTML so they stay crisp at any
// panel width; only the pace curve itself is SVG.
function SongShape({ detail, durationSec }: { detail: TrackDetail; durationSec: number | null }) {
  const d = detail.track;
  const pace = d.pace ?? [];
  const structure = d.structure ?? [];
  const vocal = d.vocalRanges; // null = not analysed, [] = instrumental
  const keys = d.keyRanges ?? [];

  // Total span: prefer real duration, else the furthest analysed endMs.
  const spans = [...pace, ...structure, ...(vocal ?? []), ...keys];
  const total = Math.max(1, durationSec != null ? durationSec * 1000 : 0, ...spans.map((s) => s.endMs));
  const pct = (ms: number) => Math.max(0, Math.min(100, (ms / total) * 100));

  if (!pace.length && !structure.length && vocal == null && !keys.length) {
    return <span className="t-caption ad-muted">no acoustic analysis</span>;
  }

  // Pace area path in a 0..100 × 0..100 viewBox (stretched to the lane).
  let pacePath = '';
  if (pace.length) {
    const pts = pace.map((p) => {
      const mx = pct((p.startMs + p.endMs) / 2);
      const my = 96 - Math.max(0, Math.min(1, p.value)) * 88;
      return [mx, my] as const;
    });
    pacePath = `M${pts[0]![0]} 96 ` + pts.map(([px, py]) => `L${px} ${py}`).join(' ') + ` L${pts[pts.length - 1]![0]} 96 Z`;
  }

  const introPct = d.introMs != null ? pct(d.introMs) : null;
  const keyLegend = Array.from(new Map(keys.map((k) => [`${k.tonic} ${k.mode}`, k])).values()).slice(0, 6);

  return (
    <div className="songshape">
      <div className="ss-row">
        <span className="ss-label">PACE</span>
        <div className="ss-lane ss-lane-pace">
          {pacePath && (
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="ss-pace-svg">
              <path d={pacePath} className="ss-pace" />
            </svg>
          )}
          {structure.map((s, i) => (i === 0 ? null : <span key={i} className="ss-sect" style={{ left: pct(s.startMs) + '%' }} />))}
          {introPct != null && <span className="ss-intro" style={{ left: introPct + '%' }} title="intro ends" />}
        </div>
      </div>

      <div className="ss-row">
        <span className="ss-label">VOICE</span>
        <div className="ss-lane ss-lane-thin">
          {vocal == null ? (
            <span className="ss-note">not analysed</span>
          ) : vocal.length === 0 ? (
            <span className="ss-note">instrumental</span>
          ) : (
            vocal.map((v, i) => (
              <span
                key={i}
                className="ss-vox"
                style={{ left: pct(v.startMs) + '%', width: Math.max(0.5, pct(v.endMs) - pct(v.startMs)) + '%' }}
              />
            ))
          )}
        </div>
      </div>

      <div className="ss-row">
        <span className="ss-label">KEY</span>
        <div className="ss-lane ss-lane-thin">
          {keys.length ? (
            keys.map((k, i) => (
              <span
                key={i}
                className="ss-key"
                style={{
                  left: pct(k.startMs) + '%',
                  width: Math.max(0.5, pct(k.endMs) - pct(k.startMs)) + '%',
                  background: keyRangeColor(k.tonic, k.mode),
                }}
                title={`${k.tonic} ${k.mode}`}
              />
            ))
          ) : (
            <span className="ss-note">—</span>
          )}
        </div>
      </div>

      {keyLegend.length > 0 && (
        <div className="ss-legend">
          {keyLegend.map((k) => (
            <span key={`${k.tonic}-${k.mode}`} className="ss-legend-item">
              <span className="ss-swatch" style={{ background: keyRangeColor(k.tonic, k.mode) }} />
              {k.tonic} {k.mode === 'major' ? 'maj' : 'min'}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Embedding fingerprint -------------------------------------------------
function Fingerprint({
  vector,
  seed,
  dim,
  cols,
  label,
  meta,
}: {
  vector?: number[] | null;
  seed: number;
  dim: number;
  cols: number;
  label: string;
  meta: string;
}) {
  const cells = useMemo(
    () => (vector && vector.length ? normaliseFingerprint(vector) : embeddingVector(seed, dim)),
    [vector, seed, dim],
  );
  return (
    <div className="fp">
      <div className="fp-head">
        <span className="t-caption" style={{ fontWeight: 700 }}>
          {label}
        </span>
        <span className="t-caption ad-muted">{meta}</span>
      </div>
      <div className="fp-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {cells.map((v, i) => (
          <span
            key={i}
            className="fp-cell"
            style={{ background: v >= 0 ? 'var(--accent)' : 'var(--ink)', opacity: 0.12 + Math.abs(v) * 0.88 }}
          />
        ))}
      </div>
    </div>
  );
}

// ---- Meter -----------------------------------------------------------------
function Meter({ value, label, cells = 20, display }: { value: number; label: string; cells?: number; display?: string }) {
  const on = Math.round(value * cells);
  return (
    <div className="meter-row">
      <span className="meter-l t-caption ad-muted">{label}</span>
      <span className="meter-cells">
        {Array.from({ length: cells }, (_, i) => (
          <span key={i} className={'meter-cell' + (i < on ? ' on' : '')} />
        ))}
      </span>
      <span className="meter-v t-nums">{display ?? value.toFixed(2)}</span>
    </div>
  );
}

// ============================================================================
//  STATS VIEW  (library overview, recomputes from filtered list)
// ============================================================================
export function StatsView({ stats, list, filtered }: { stats: ObservatoryStats; list: ObsTrack[]; filtered: boolean }) {
  const moods = useMemo(() => tally(list, (t) => t.moods).slice(0, 8), [list]);
  const genres = useMemo(() => tally(list, (t) => t.genre), [list]);
  const moodTagCount = useMemo(() => tally(list, (t) => t.moods).length, [list]);
  const energy = useMemo(() => {
    const o = { low: 0, medium: 0, high: 0 };
    list.forEach((t) => {
      if (t.energy) o[t.energy]++;
    });
    return o;
  }, [list]);
  const artists = useMemo(() => new Set(list.map((t) => (t.artist || '').trim().toLowerCase()).filter(Boolean)).size, [list]);
  const analysed = list.filter((t) => t.analysed).length;
  const loudnessCount = useMemo(() => list.filter((t) => t.loudnessLufs != null).length, [list]);
  const voice = useMemo(() => {
    const o = { vocal: 0, instrumental: 0, unknown: 0 };
    list.forEach((t) => {
      if (t.vocal === 'vocal') o.vocal++;
      else if (t.vocal === 'instrumental') o.instrumental++;
      else o.unknown++;
    });
    return o;
  }, [list]);
  const mode = useMemo(() => {
    const o = { major: 0, minor: 0 };
    list.forEach((t) => {
      if (!t.musicalKey) return;
      if (t.musicalKey.endsWith('B')) o.major++;
      else if (t.musicalKey.endsWith('A')) o.minor++;
    });
    return o;
  }, [list]);
  const voiceMax = Math.max(1, voice.vocal, voice.instrumental, voice.unknown);
  const modeMax = Math.max(1, mode.major, mode.minor);
  const moodMax = Math.max(1, ...moods.map((m) => m[1]));
  const genreMax = Math.max(1, ...genres.map((g) => g[1]));
  const eMax = Math.max(1, energy.low, energy.medium, energy.high);
  const pct = (n: number) => (list.length ? Math.round((n / list.length) * 100) : 0);
  const embeddedPct = stats.total ? Math.round((stats.withEmbedding / stats.total) * 100) : 0;

  return (
    <div className="obs-stack">
      <div className="ad-strip obs-strip">
        <div className="ad-strip-cell">
          <span className="ad-strip-v t-nums">{list.length}</span>
          <span className="t-caption ad-muted">{filtered ? 'IN VIEW' : 'TRACKS'}</span>
        </div>
        <div className="ad-strip-cell">
          <span className="ad-strip-v t-nums acc">{pct(analysed)}%</span>
          <span className="t-caption ad-muted">ANALYSED</span>
        </div>
        <div className="ad-strip-cell">
          <span className="ad-strip-v t-nums">{artists}</span>
          <span className="t-caption ad-muted">ARTISTS</span>
        </div>
        <div className="ad-strip-cell">
          <span className="ad-strip-v t-nums">{embeddedPct}%</span>
          <span className="t-caption ad-muted">EMBEDDED</span>
        </div>
      </div>

      <Card title="ENERGY" sub="LOW · MED · HIGH">
        <Bar label="LOW" value={energy.low} max={eMax} />
        <Bar label="MEDIUM" value={energy.medium} max={eMax} />
        <Bar label="HIGH" value={energy.high} max={eMax} accent />
      </Card>

      <Card title="MOOD FIELD" sub={`${moodTagCount} TAGS`}>
        {moods.length ? (
          moods.map(([m, n]) => <Bar key={m} label={m} value={n} max={moodMax} accent={m === moods[0]?.[0]} />)
        ) : (
          <span className="t-caption ad-muted">no moods in view</span>
        )}
      </Card>

      <Card title="TEMPO" sub="ACOUSTIC PASS">
        <TempoRiver list={list} />
      </Card>

      <Card title="LOUDNESS" sub={`${pct(loudnessCount)}% MEASURED`}>
        <LoudnessRiver list={list} />
      </Card>

      <Card title="HARMONIC WHEEL" sub="CAMELOT">
        <KeyWheel list={list} />
      </Card>

      <Card title="MODE" sub="MAJOR · MINOR">
        <Bar label="MAJOR" value={mode.major} max={modeMax} accent />
        <Bar label="MINOR" value={mode.minor} max={modeMax} />
      </Card>

      <Card title="VOICE" sub="VOCAL · INSTRUMENTAL">
        <Bar label="VOCAL" value={voice.vocal} max={voiceMax} accent />
        <Bar label="INSTRUMENTAL" value={voice.instrumental} max={voiceMax} />
        {voice.unknown > 0 && <Bar label="UNANALYSED" value={voice.unknown} max={voiceMax} />}
      </Card>

      <Card title="SCENES" sub={`${genres.length} GENRES`}>
        {genres.slice(0, 10).map(([g, n]) => (
          <Bar key={g} label={g} value={n} max={genreMax} accent={g === genres[0]?.[0]} />
        ))}
      </Card>
    </div>
  );
}

// ============================================================================
//  DOSSIER  (one inspected track — the full record)
// ============================================================================
export function Dossier({
  track,
  detail,
  loading,
  mixNodes,
  onSelect,
  onClose,
}: {
  track: ObsTrack;
  detail: TrackDetail | null;
  loading: boolean;
  mixNodes: ObsTrack[];
  onSelect: (t: ObsTrack) => void;
  onClose: () => void;
}) {
  const dur = (s: number | null) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
  const d = detail?.track;
  const lastfm = d?.lastfmTags ?? null;
  const lyric = d?.lyricExcerpt ?? null;

  return (
    <div className="obs-stack dossier">
      <div className="dossier-head">
        <button className="dossier-back" onClick={onClose}>
          ← LIBRARY
        </button>
        <span className="t-caption ad-muted">TRACK DOSSIER{loading ? ' · LOADING…' : ''}</span>
      </div>

      <div className="dossier-title-block">
        <div className="t-caption ad-muted">
          {(track.genre || 'UNFILED')}
          {track.year ? ` · ${track.year}` : ''}
        </div>
        <h2 className="dossier-title">{track.title || 'Untitled'}</h2>
        <div className="dossier-artist">{track.artist || 'Unknown artist'}</div>
        {track.album && (
          <div className="t-caption ad-muted" style={{ marginTop: 4 }}>
            {track.album}
          </div>
        )}
      </div>

      <div className="ad-strip dossier-strip">
        <div className="ad-strip-cell">
          <span className="ad-strip-v t-nums">{track.bpm ?? '—'}</span>
          <span className="t-caption ad-muted">BPM</span>
        </div>
        <div className="ad-strip-cell">
          <span className="ad-strip-v t-nums acc">{track.musicalKey ?? '—'}</span>
          <span className="t-caption ad-muted">KEY</span>
        </div>
        <div className="ad-strip-cell">
          <span className="ad-strip-v t-nums" style={{ textTransform: 'uppercase', fontSize: 13 }}>
            {track.energy ?? '—'}
          </span>
          <span className="t-caption ad-muted">ENERGY</span>
        </div>
        <div className="ad-strip-cell">
          <span className="ad-strip-v t-nums">{dur(track.durationSec)}</span>
          <span className="t-caption ad-muted">LENGTH</span>
        </div>
      </div>

      <Card title="TAGS" sub={(track.source ?? '—').toUpperCase()}>
        <div className="t-caption ad-muted" style={{ marginBottom: 8 }}>
          MOOD
        </div>
        <div className="pill-row">
          {track.moods.length ? (
            track.moods.map((m) => (
              <span key={m} className="ad-pill acc">
                {m}
              </span>
            ))
          ) : (
            <span className="t-caption ad-muted">—</span>
          )}
        </div>
        {lastfm && lastfm.length > 0 && (
          <>
            <div className="t-caption ad-muted" style={{ margin: '12px 0 8px' }}>
              LAST.FM
            </div>
            <div className="pill-row">
              {lastfm.map((m) => (
                <span key={m} className="ad-pill">
                  {m}
                </span>
              ))}
            </div>
          </>
        )}
        <div style={{ marginTop: 14 }}>
          <Meter value={track.energyVal} label="ENERGY" />
          {track.confidence != null && <Meter value={track.confidence} label="TAG CONF" />}
          {track.analysisConfidence != null && <Meter value={track.analysisConfidence} label="ACOUSTIC" />}
          {d?.loudnessLufs != null && (
            <Meter value={loudnessToVal(d.loudnessLufs)} label="LOUDNESS" display={`${d.loudnessLufs.toFixed(1)} LUFS`} />
          )}
        </div>
      </Card>

      {detail && (
        <Card title="SONG SHAPE" sub="ACOUSTIC TIMELINE">
          <SongShape detail={detail} durationSec={track.durationSec} />
        </Card>
      )}

      {lyric && (
        <Card title="LYRIC" sub="EXCERPT">
          <blockquote className="dossier-lyric">“{lyric}”</blockquote>
        </Card>
      )}

      <Card title="EMBEDDINGS" sub="LEARNED VECTORS">
        <Fingerprint
          vector={detail?.textEmbedding}
          seed={track._eseed}
          dim={768}
          cols={48}
          label="TEXT"
          meta={detail?.textEmbedding ? `${detail.textEmbedding.length}d · ${d?.model || 'model'}` : 'no vector'}
        />
        {detail?.audioEmbedding ? (
          <>
            <div style={{ height: 14 }} />
            <Fingerprint
              vector={detail.audioEmbedding}
              seed={track._eseed ^ 0x9e37}
              dim={512}
              cols={48}
              label="AUDIO"
              meta={`${detail.audioEmbedding.length}d · laion-clap`}
            />
          </>
        ) : null}
      </Card>

      <Card title="MIX NEXT" sub="NEAREST IN VECTOR SPACE">
        {mixNodes.length ? (
          <div className="mixlist">
            {mixNodes.map((n) => (
              <button key={n.idx} className="mix-row" onClick={() => onSelect(n)}>
                <span className="mix-dot" style={{ background: heat(n.energyVal) }} />
                <span className="mix-tt">
                  <span className="mix-title">{n.title || 'Untitled'}</span>
                  <span className="mix-artist">{n.artist || 'Unknown'}</span>
                </span>
                <span className="mix-meta t-nums">
                  {n.bpm ?? '—'} · {n.musicalKey ?? '—'}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <span className="t-caption ad-muted">{loading ? 'finding neighbours…' : 'no embedding neighbours'}</span>
        )}
      </Card>

      <div className="dossier-foot t-caption ad-muted">
        <div>ID {track.id.slice(0, 16)}…</div>
        <div>
          SOURCE {track.source ?? '—'}
          {d?.taggerVersion ? ` · v${d.taggerVersion}` : ''}
          {d?.model ? ` · ${d.model}` : ''}
        </div>
        {d?.introMs != null && (
          <div>
            INTRO {(d.introMs / 1000).toFixed(1)}s
            {d?.analysisVersion != null ? ` · ANALYSIS v${d.analysisVersion}` : ''}
          </div>
        )}
      </div>
    </div>
  );
}
