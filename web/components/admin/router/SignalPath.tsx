'use client';

// The routing monitor: the station's real Subsonic requests travelling
// station → router → source, with a feed of the last few dozen and an
// inspector for one. Selecting a request holds the feed so it can be read;
// polling itself is owned by RouterPanel, which stops when paused.

import { useState } from 'react';
import { Activity, ArrowRight, AudioLines, Pause, Play, Radio, Server } from 'lucide-react';
import { Btn } from '../ui';
import type { RouterActivity } from '../../../lib/schemas.generated';
import { activityMetrics, backendNote, clientLabel, formatMs, sourcesOf, type Channel } from './model';
import s from './router.module.css';

// The SVG is drawn in a 1000×360 box stretched over the map; nodes are laid
// out in CSS at matching fractions (client 0–21%, router 39–60%, backends 75%+).
const VIEW_H = 360;
const ROUTER_IN = 'M 210 180 H 390';
const wireTo = (index: number, total: number) => `M 600 180 H 670 V ${((index + 0.5) * VIEW_H) / total} H 750`;

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });

export interface SignalPathProps {
  activity: RouterActivity | undefined;
  backends: Channel[];
  connected: boolean;
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  error: string | null;
}

export function SignalPath({ activity, backends, connected, paused, onPausedChange, error }: SignalPathProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const requests = activity?.requests ?? [];
  const selected = requests.find((r) => r.id === selectedId) ?? requests[0];
  const metrics = activityMetrics(requests);
  const live = connected && !paused;
  const recent = selected && activity ? activity.now - selected.at < 2500 : false;
  const select = (id: string) => {
    setSelectedId(id);
    onPausedChange(true);
  };

  const statusText = paused ? 'CAPTURE PAUSED' : error ? 'NO SIGNAL' : connected ? 'LIVE / 1.5s' : activity ? 'RECONNECTING…' : 'CONNECTING…';

  return (
    <div className={s.monitor}>
      <div className={s.toolbar}>
        <span className={s.status} data-live={live} role="status">
          <i />
          {statusText}
        </span>
        <span className={s.toolbarNote}>
          {error ? <span className={s.errorText}>{error}</span> : <>Actual requests · latest {activity?.capacity ?? 60} · memory only, no ids or credentials</>}
        </span>
        <Btn
          sm
          onClick={() => {
            onPausedChange(!paused);
            setSelectedId(null);
          }}
        >
          {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          {paused ? 'Resume live' : 'Pause feed'}
        </Btn>
      </div>

      <div className={s.layout}>
        <div className={s.display}>
          <div className={s.displayHeading}>
            <span>ROUTING MONITOR</span>
            <span>{selected ? (paused ? 'INSPECTING REQUEST' : 'LATEST REQUEST') : 'AWAITING SIGNAL'}</span>
          </div>
          <div className={s.map}>
            <svg className={s.wires} viewBox={`0 0 1000 ${VIEW_H}`} preserveAspectRatio="none" aria-hidden="true">
              <path className={s.wire} d={ROUTER_IN} />
              {backends.map((b, i) => (
                <path key={b.key} className={s.wire} data-used={Boolean(selected?.calls.some((c) => c.source === b.name))} d={wireTo(i, backends.length)} />
              ))}
              {selected && <path key={selected.id} className={s.packet} data-moving={recent && live} d={ROUTER_IN} />}
              {selected &&
                backends.map((b, i) =>
                  selected.calls.some((c) => c.source === b.name) ? (
                    <path key={`${selected.id}-${b.key}`} className={s.packet} data-moving={recent && live} d={wireTo(i, backends.length)} />
                  ) : null,
                )}
            </svg>

            <div className={`${s.node} ${s.client}`}>
              <Radio aria-hidden="true" />
              <span>INPUT</span>
              <strong>{selected ? clientLabel(selected.client) : 'Station'}</strong>
              <small>controller · liquidsoap · analyzer</small>
            </div>

            <div className={`${s.node} ${s.routerNode}`} data-error={selected?.state === 'error'}>
              <AudioLines aria-hidden="true" />
              <span>ROUTER</span>
              <strong>{selected?.endpoint ?? 'Listening'}</strong>
              <small>
                {selected
                  ? `${selected.state === 'error' ? 'Failed' : selected.state === 'pending' ? 'Processing' : 'Returned'} · ${formatMs(selected.ms)}`
                  : 'Waiting for the station to ask'}
              </small>
            </div>

            <div className={s.backends}>
              {backends.map((b) => {
                const note = backendNote(b.name, selected, b);
                return (
                  <div key={b.key} className={s.backend} data-used={note.used} data-failed={note.failed} data-serving={b.onAir}>
                    <Server aria-hidden="true" />
                    <div>
                      <strong title={b.label}>{b.name}</strong>
                      <small>{note.text}</small>
                    </div>
                    <i title={b.onAir ? 'In the serving set' : 'Not serving'} />
                  </div>
                );
              })}
            </div>
          </div>
          <div className={s.legend}>
            <span><i />Observed source call</span>
            <span>→ Request direction</span>
            <span>Timing includes backend wait</span>
          </div>
        </div>

        <aside className={s.feed} aria-label="Recent requests">
          <div className={s.feedHeading}>
            <Activity aria-hidden="true" />
            <strong>Request feed</strong>
            <span>{requests.length} captured</span>
          </div>
          <div className={s.feedList}>
            {!requests.length ? (
              <div className={s.feedEmpty}>
                <Radio aria-hidden="true" />
                <strong>{connected ? 'Listening for the first request' : 'Connecting to the router'}</strong>
                <p>
                  Every Subsonic call the station makes through the router shows up here: track picks,
                  library walks, Liquidsoap downloading the next song, the analyzer fetching audio.
                </p>
              </div>
            ) : (
              requests.map((r) => (
                <button
                  type="button"
                  className={s.event}
                  key={r.id}
                  onClick={() => select(r.id)}
                  aria-pressed={r.id === selected?.id}
                >
                  <span className={s.dot} data-state={r.state} />
                  <span>
                    <strong>{r.endpoint}</strong>
                    <small>
                      {clientLabel(r.client)} → {sourcesOf(r).join(' + ') || 'router only'}
                    </small>
                  </span>
                  <span className={s.eventTime}>
                    <b>{r.state === 'error' ? 'Failed' : formatMs(r.ms)}</b>
                    <small>{clock(r.at)}</small>
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>
      </div>

      <div className={s.bottom}>
        <div className={s.metrics}>
          <div>
            <span>CAPTURED</span>
            <strong>{metrics.captured}</strong>
          </div>
          <div>
            <span>AVG RESPONSE</span>
            <strong>{metrics.avgMs === null ? '—' : formatMs(metrics.avgMs)}</strong>
          </div>
          <div>
            <span>FAILED</span>
            <strong className={metrics.failed ? s.errorText : undefined}>{metrics.failed}</strong>
          </div>
          <div>
            <span>SINCE START</span>
            <strong>{activity ? activity.totals.requests.toLocaleString() : '—'}</strong>
          </div>
        </div>
        <div className={s.inspector}>
          <span>
            {selected ? (
              <>
                <b>{selected.endpoint}</b>
                <ArrowRight aria-hidden="true" />
                {selected.calls.length ? (
                  selected.calls.map((c, i) => (
                    <code key={i} data-state={c.state} className={c.state === 'error' ? s.errorText : undefined}>
                      {c.source}.{c.op} · {c.state === 'unsupported' ? 'not supported' : formatMs(c.ms)}
                      {c.state === 'error' ? ' · failed' : ''}
                    </code>
                  ))
                ) : (
                  <span>{selected.state === 'error' ? 'Refused before reaching a source' : 'Answered by the router'}</span>
                )}
              </>
            ) : (
              'No traffic captured yet. Only real requests appear here.'
            )}
          </span>
          {selected?.error && <span className={s.inspectorError}>✗ {selected.error}</span>}
          <small>
            {paused ? 'Snapshot held. Resume to catch up with live traffic.' : 'Select a request to hold and inspect its route.'}
          </small>
        </div>
      </div>
    </div>
  );
}
