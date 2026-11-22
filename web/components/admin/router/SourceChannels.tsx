'use client';

// One channel strip per plugin: health lamp, library counts, latency, the
// capability bank and its settings. Serving channels sit first and stand at
// full opacity; the merged bus follows them when more than one is serving.
// Choosing what serves stays on the Sources tab, where a switch also
// re-links the library — so a standby strip links there instead of toggling.

import Link from 'next/link';
import { CAPABILITY_BANK, formatMs, type Channel } from './model';
import s from './router.module.css';

const SEGMENTS = 12;

const LAMP_TEXT: Record<Channel['lamp'], string> = {
  healthy: 'healthy',
  unreachable: 'unreachable',
  'not-configured': 'not configured',
  error: 'error',
  standby: 'standby',
  broken: 'load error',
  bus: 'derived',
};

function SignalMeter({ lit, label }: { lit: number; label: string }) {
  return (
    <div className={s.meter} role="img" aria-label={`${label} signal level ${lit} of ${SEGMENTS}`}>
      <div className={s.meterStack} aria-hidden="true">
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <span key={i} className={s.segment} data-on={i < lit} />
        ))}
      </div>
      <span aria-hidden="true">SIG</span>
    </div>
  );
}

const count = (n: number | undefined) => (n === undefined ? '—' : n.toLocaleString());

function ChannelStrip({ channel }: { channel: Channel }) {
  const bus = channel.kind === 'bus';
  const ids = channel.idPrefix ? ` · ids ${channel.rawIds ? 'raw' : `${channel.idPrefix}-`}` : '';
  return (
    <article className={s.strip} data-lamp={channel.lamp} data-onair={channel.onAir} data-kind={channel.kind}>
      <div className={s.nameRow}>
        <strong title={channel.label}>{bus ? `BUS ${channel.name}` : channel.label}</strong>
        <span className={s.lamp} title={LAMP_TEXT[channel.lamp]} aria-hidden="true" />
      </div>
      {!bus && (
        <code className={s.stripId}>
          {channel.name}
          {channel.version ? ` v${channel.version}` : ''}
          {ids}
        </code>
      )}

      <div className={s.badges}>
        <span className={s.stateBadge}>{LAMP_TEXT[channel.lamp]}</span>
        {channel.onAir && !bus && <b>on air</b>}
        {bus && <b>merged view</b>}
        {!bus && <span>{channel.builtin ? 'built-in' : 'installed'}</span>}
      </div>

      <div className={s.readings}>
        <SignalMeter lit={channel.meter} label={channel.label} />
        <div className={s.numbers}>
          <strong>{channel.readout}</strong>
          <span>{channel.caption}</span>
          <dl>
            <div><dt>ARTISTS</dt><dd>{count(channel.stats?.artists)}</dd></div>
            <div><dt>ALBUMS</dt><dd>{count(channel.stats?.albums)}</dd></div>
            <div><dt>SONGS</dt><dd>{count(channel.stats?.songs)}</dd></div>
            <div><dt>GENRES</dt><dd>{count(channel.stats?.genres)}</dd></div>
            {!bus && <div><dt>LATENCY</dt><dd>{channel.ms === null ? '—' : formatMs(channel.ms)}</dd></div>}
          </dl>
        </div>
      </div>

      <div className={s.capBank}>
        <span className={s.bankLabel}>
          capabilities{channel.capabilities === null ? ' · unknown until built' : ''}
        </span>
        <div>
          {CAPABILITY_BANK.map(({ key, short, label }) => {
            const on = channel.capabilities ? channel.capabilities[key] : null;
            const state = on === null ? 'unknown' : on ? 'supported' : 'not supported';
            return (
              <span key={key} className={s.cap} data-on={on === true} title={`${label}: ${state}`}>
                <b aria-hidden="true">{on === null ? '·' : on ? '✓' : '×'}</b>
                <small>{short}</small>
                <span className="sr-only">{`${label}: ${state}`}</span>
              </span>
            );
          })}
        </div>
      </div>

      <p className={s.detail} data-alert={channel.alert} title={channel.detail}>
        {channel.detail}
      </p>

      {channel.settings.length > 0 && (
        <dl className={s.settings}>
          {channel.settings.map((f) => (
            <div key={f.key} className="contents">
              <dt>{f.label}</dt>
              <dd title={f.value}>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className={s.spacer} />
      {bus ? (
        <p className={s.busNote}>Derived from the serving set · not configurable</p>
      ) : channel.onAir ? (
        <div className={s.stripFoot} data-up="true">
          <span className={s.fader} aria-hidden="true"><span /></span>
          <span>
            <b>SERVING</b>
            <small>in the station&apos;s set</small>
          </span>
        </div>
      ) : (
        <Link href="/admin/sources?tab=sources" className={s.stripFoot} data-up="false">
          <span className={s.fader} aria-hidden="true"><span /></span>
          <span>
            <b>{channel.lamp === 'broken' ? 'UNAVAILABLE' : 'STANDBY'}</b>
            <small>{channel.lamp === 'broken' ? 'fix the plugin, then rescan' : 'add on the sources tab →'}</small>
          </span>
        </Link>
      )}
    </article>
  );
}

export function SourceChannels({ channels }: { channels: Channel[] }) {
  if (!channels.length) return <p className={s.empty}>The router reported no plugins.</p>;
  return (
    <div className={s.sourceBank}>
      {channels.map((c) => (
        <ChannelStrip key={c.key} channel={c} />
      ))}
    </div>
  );
}
