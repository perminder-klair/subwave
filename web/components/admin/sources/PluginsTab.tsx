'use client';

// Admin → Music sources → Plugins: the plugin bay (#692). Every music-source
// plugin the router has loaded is a module in a rack — slot number, status
// lamp, a patch field of capability jacks, a strip of the Subsonic endpoints it
// backs, its settings as knobs — and the selected one prints its manifest on
// the same phosphor scope as the Monitor's routing display. The rack ends in an
// empty slot, because installing is still "copy the folder, press Rescan": a
// plugin is code that runs inside the router, so it arrives by the operator's
// hand. Built on the router console's rack (router/router.module.css).

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { AlertTriangle, ExternalLink, Lock, Puzzle } from 'lucide-react';
import { buttonVariants } from '../../ui/button';
import { V3Alert } from '../../ui/alert';
import { RackPanel } from '../router/Rack';
import { CAPABILITY_BANK, formatMs } from '../router/model';
import rs from '../router/router.module.css';
import { bayReadout, buildBay, slotLabel, type BayModule, type CellState } from './pluginBay';
import ps from './plugins.module.css';
import type { MusicSourceView } from './queries';

const PLUGIN_GUIDE = 'https://github.com/perminder-klair/subwave/blob/main/docs/music-source-plugins.md';
const NAVIDROME = 'navidrome';

const STATE_TEXT: Record<BayModule['state'], string> = { onair: 'on air', standby: 'standby', fault: 'fault' };
const GLYPH: Record<CellState, string> = { full: '●', degraded: '◐', unsupported: '×', unknown: '·' };

export function PluginsTab({ view }: { view: MusicSourceView }) {
  const status = view.router;
  const modules = useMemo(() => (status ? buildBay(status, view.mode === 'router') : []), [status, view.mode]);
  const [selected, setSelected] = useState<string | null>(null);
  const current = modules.find((m) => m.plugin.name === selected) ?? modules[0];

  if (!status) {
    return (
      <V3Alert tone="error" title="music router unreachable">
        {view.routerError} — the plugin bay reads the router. Start the <code>router</code> service and reload.
      </V3Alert>
    );
  }

  const r = bayReadout(modules);
  return (
    <div className={rs.console}>
      <RackPanel
        title="Module rack"
        description="Every music-source plugin the router has loaded, one per slot. Built-ins ship with SUB/WAVE; installed modules came from state/router/plugins/. Select one to inspect it."
        action={
          <span className={ps.readout} aria-label="Plugin bay readout">
            <span>{r.slots} slots</span>
            <span data-tone={r.onAir ? 'ok' : undefined}>{r.onAir} on air</span>
            <span>{r.installed} installed</span>
            <span data-tone={r.faults ? 'bad' : undefined}>{r.faults} {r.faults === 1 ? 'fault' : 'faults'}</span>
          </span>
        }
      >
        <div className={ps.bay}>
          {modules.map((m) => (
            <Module key={m.plugin.name} module={m} selected={m === current} onSelect={() => setSelected(m.plugin.name)} />
          ))}
          <div className={ps.empty}>
            <b aria-hidden="true">+</b>
            <strong>{slotLabel(modules.length + 1)} · EMPTY</strong>
            <span>Drop a plugin folder into state/router/plugins/ and press Rescan.</span>
          </div>
        </div>
      </RackPanel>

      {current && (
        <RackPanel
          title="Module inspector"
          description="The selected module's manifest, the settings it asks for, and every Subsonic endpoint it backs — the same table the router answers from."
        >
          <Inspector module={current} />
        </RackPanel>
      )}

      <RackPanel title="Install a module" description="A folder and a Rescan — no restart, no rebuild.">
        <Install />
      </RackPanel>

      <footer className={rs.footer}>
        <Puzzle aria-hidden="true" />
        SUB/WAVE / MUSIC ROUTER / PLUGIN BAY / {r.slots} SLOTS
      </footer>
    </div>
  );
}

function Module({ module: m, selected, onSelect }: { module: BayModule; selected: boolean; onSelect: () => void }) {
  const p = m.plugin;
  const fault = m.state === 'fault';
  const c = m.coverage;
  const backs = [
    `BACKS ${c.full}/${c.total}`,
    c.degraded ? `${c.degraded} LESS` : '',
    c.unsupported ? `${c.unsupported} NONE` : '',
    c.unknown ? `${c.unknown} UNKNOWN` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <button
      type="button"
      className={ps.module}
      data-state={m.state}
      aria-pressed={selected}
      aria-label={`${slotLabel(m.slot)}: ${p.label}, ${STATE_TEXT[m.state]}. Inspect.`}
      onClick={onSelect}
    >
      <span className={ps.ears}>
        <span className={ps.hole} aria-hidden="true" />
        <span className={ps.slot}>{slotLabel(m.slot)}</span>
        <span className={ps.led} title={STATE_TEXT[m.state]} aria-hidden="true" />
        <span className={ps.hole} aria-hidden="true" />
      </span>
      <span className={ps.title}>
        <strong>{p.label}</strong>
        <code>{p.name} · v{p.version || '—'} · API v{p.apiVersion}</code>
      </span>
      <span className={ps.tags}>
        {m.state === 'onair' && <b>on air</b>}
        {fault && <span className={ps.warn}>fault</span>}
        {m.state === 'standby' && <span>standby</span>}
        <span>{p.builtin ? 'built-in' : 'installed'}</span>
        {m.rawIds ? <span>raw ids</span> : p.idPrefix && <span>ids {p.idPrefix}-</span>}
        {p.devOnly && <span>dev only</span>}
      </span>

      {fault ? (
        <span className={ps.faultText}>✗ {p.error}</span>
      ) : (
        <>
          <span className={ps.jacks} aria-hidden="true">
            {CAPABILITY_BANK.map(({ key, short, label }) => {
              const on = m.capabilities ? (m.capabilities[key] ? 'true' : 'false') : 'unknown';
              const said = on === 'unknown' ? 'unknown until built' : on === 'true' ? 'supported' : 'not supported';
              return (
                <span key={key} className={ps.jack} data-on={on} title={`${label}: ${said}`}>
                  <span className={ps.socket} />
                  <small>{short}</small>
                </span>
              );
            })}
          </span>
          <span className={ps.strip}>
            <span aria-hidden="true">
              {c.cells.map((cell) => <span key={cell.endpoint} className={ps.cell} data-cell={cell.state} />)}
            </span>
            <small>{backs}</small>
          </span>
          {p.name === NAVIDROME ? (
            <span className={ps.knobNote}>Plays the station&apos;s Navidrome connection — set on the Sources tab.</span>
          ) : p.config.length ? (
            <span className={ps.knobs}>
              {p.config.map((f) => (
                <span key={f.key} className={ps.knob} data-required={Boolean(f.required)}>
                  {f.label}
                  {f.type === 'secret' && <Lock aria-label="secret" />}
                  {p.envLocked.includes(f.key) && ' · env'}
                </span>
              ))}
            </span>
          ) : (
            <span className={ps.knobNote}>No settings.</span>
          )}
        </>
      )}
    </button>
  );
}

function Line({ k, children, className }: { k: string; children: ReactNode; className?: string }) {
  return (
    <div className={ps.line}>
      <span>{k}</span>
      <span className={className}>{children}</span>
    </div>
  );
}

function Inspector({ module: m }: { module: BayModule }) {
  const p = m.plugin;
  const c = m.coverage;
  const short = c.cells.filter((x) => x.state !== 'full');
  const health = m.health;
  const unhealthy = m.state === 'fault' || Boolean(health && health.state !== 'healthy');
  const stateLine =
    m.state === 'onair'
      ? `on air · ${health?.state ?? 'unknown'}${health?.ms !== undefined ? ` · ${formatMs(health.ms)}` : ''}${health?.stats ? ` · ${health.stats.songs.toLocaleString()} songs` : ''}`
      : STATE_TEXT[m.state];
  return (
    <div className={ps.inspector}>
      <div className={ps.scope} role="region" aria-label={`${p.label} manifest`} aria-live="polite">
        <div className={ps.scopeHead}>
          <span>MODULE INSPECTOR</span>
          <span>{slotLabel(m.slot)} · {STATE_TEXT[m.state].toUpperCase()}</span>
        </div>
        <Line k="MODULE">{p.name}</Line>
        <Line k="LABEL">{p.label}</Line>
        <Line k="VERSION">{p.version || '—'} · plugin API v{p.apiVersion}</Line>
        <Line k="IDS">{m.rawIds ? 'raw — the server’s own' : p.idPrefix ? `${p.idPrefix}-<native id>` : '—'}</Line>
        <Line k="ORIGIN">{p.builtin ? 'built-in' : `installed · state/router/plugins/${p.name}/`}</Line>
        <Line k="STATE" className={unhealthy ? ps.err : undefined}>{stateLine}</Line>
        {health?.error && <Line k="ERROR" className={ps.err}>{health.error}</Line>}
        {p.description && <Line k="ABOUT" className={ps.dim}>{p.description}</Line>}
        <div className={ps.rule} />

        {m.state === 'fault' ? (
          <>
            <div className={ps.sub}>FAULT</div>
            <div className={ps.err}>✗ {p.error}</div>
            <div className={ps.dim}>Fix the module&apos;s folder, then press Rescan plugins.</div>
          </>
        ) : (
          <>
            <div className={ps.sub}>SETTINGS</div>
            {p.name === NAVIDROME ? (
              <div className={ps.dim}>none of its own — plays the station&apos;s Navidrome connection (Sources tab)</div>
            ) : p.config.length ? (
              p.config.map((f) => (
                <div key={f.key} className={ps.row}>
                  <span>{f.required ? '*' : ' '}</span>
                  <span>{f.key}</span>
                  <span className={ps.dim}>
                    {f.label} · {f.type}
                    {f.type === 'secret' ? ' · write-only' : ''}
                    {p.envLocked.includes(f.key) ? ' · from env' : f.env ? ` · env ${f.env}` : ''}
                    {f.affectsIds ? ' · re-keys ids' : ''}
                  </span>
                </div>
              ))
            ) : (
              <div className={ps.dim}>none</div>
            )}
            <div className={ps.rule} />
            <div className={ps.sub}>BACKS</div>
            {m.capabilities === null ? (
              <div className={ps.dim}>unknown until it is selected or tested — capabilities are read off a running module</div>
            ) : (
              <>
                <div>{c.full}/{c.total} Subsonic endpoints in full</div>
                {short.length === 0 && <div className={ps.dim}>every endpoint the station calls</div>}
                {short.map((x) => (
                  <div key={x.endpoint} className={ps.row} data-cell={x.state}>
                    <span>{GLYPH[x.state]}</span>
                    <span>{x.endpoint}</span>
                    <span className={ps.dim}>
                      {x.state === 'degraded' ? 'answers with less' : 'answers an error'}
                      {x.feature ? ` — ${x.feature}` : ''}
                    </span>
                  </div>
                ))}
              </>
            )}
          </>
        )}
        <div className={ps.rule} />
        <div>
          <span className={ps.dim}>&gt;</span> <span className={ps.cursor} aria-hidden="true" />
        </div>
      </div>

      <div className={ps.plate}>
        <div className={ps.meterBig}>
          <div><span>FULL</span><strong data-tone="ok">{m.capabilities ? c.full : '—'}</strong></div>
          <div><span>LESS</span><strong data-tone={c.degraded ? 'warn' : undefined}>{m.capabilities ? c.degraded : '—'}</strong></div>
          <div><span>NONE</span><strong data-tone={c.unsupported ? 'bad' : undefined}>{m.capabilities ? c.unsupported : '—'}</strong></div>
        </div>
        <dl className={ps.spec}>
          <div><dt>Model</dt><dd>{p.label}</dd></div>
          <div><dt>Code</dt><dd>{p.name}</dd></div>
          <div><dt>Firmware</dt><dd>v{p.version || '—'}</dd></div>
          <div><dt>Plugin API</dt><dd>v{p.apiVersion}</dd></div>
          <div><dt>Ids</dt><dd>{m.rawIds ? 'raw' : p.idPrefix ? `${p.idPrefix}-` : '—'}</dd></div>
          <div><dt>Origin</dt><dd>{p.builtin ? 'built-in' : 'installed'}</dd></div>
          <div><dt>Latency</dt><dd>{health?.ms !== undefined ? formatMs(health.ms) : '—'}</dd></div>
        </dl>
        <div className={ps.plateActions}>
          {m.state !== 'fault' && (
            <Link
              href="/admin/sources?tab=sources"
              className={buttonVariants({ variant: m.state === 'onair' ? 'outline' : 'solid', size: 'sm' })}
            >
              {m.state === 'onair' ? 'Configure on Sources' : 'Add on Sources'}
            </Link>
          )}
          {p.homepage && (
            <a href={p.homepage} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Homepage <ExternalLink aria-hidden="true" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function Install() {
  return (
    <div className={ps.install}>
      <div className={ps.tapes}>
        <span className={ps.tape}><b>1</b><span>Copy the folder to <code>state/router/plugins/</code></span></span>
        <span className={ps.tape}><b>2</b><span>Press Rescan plugins</span></span>
        <span className={ps.tape}><b>3</b><span>Add it on Sources · Test · Save</span></span>
      </div>
      <pre className={ps.term}>
        <span className={ps.dim}>$ tree state/router/plugins</span>
        {'\nstate/router/plugins/\n└── my-source/\n    ├── subwave-source.json  '}
        <span className={ps.dim}># name, label, idPrefix, config[]</span>
        {'\n    └── index.mjs            '}
        <span className={ps.dim}># export default (ctx) =&gt; source</span>
      </pre>
      <div className={ps.hazard}>
        <div>
          <AlertTriangle aria-hidden="true" />
          <span>
            <strong>Plugins are code.</strong> They run inside the router, with its access to your music servers — install
            only what you have read and trust. Writing one?{' '}
            <a href={PLUGIN_GUIDE} target="_blank" rel="noopener noreferrer">The plugin author guide</a> covers the
            contract and the conformance kit.
          </span>
        </div>
      </div>
    </div>
  );
}
