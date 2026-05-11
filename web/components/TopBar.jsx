'use client';

import { Settings, Radio } from 'lucide-react';
import { useClock } from '../lib/hooks';

export default function TopBar({ tunedIn, context, transmission, djName, onOpenSettings, tickerOn, onToggleTicker }) {
  const clock = useClock();
  const time = clock ? clock.toLocaleTimeString('en-GB', { hour12: false }) : '--:--:--';
  const city = context?.weather?.locationName || context?.city;
  const temp = context?.weather?.temp;
  const cond = context?.weather?.condition;

  return (
    <div
      className="absolute top-0 left-0 right-0 flex items-baseline justify-between z-20"
      style={{ padding: '24px 32px', borderBottom: '1px solid var(--ink)' }}
    >
      <div className="flex items-baseline gap-[14px]">
        <span className="v3-eyebrow">SUB/WAVE</span>
        {djName && (
          <span className="v3-caption" style={{ color: 'var(--accent)' }}>
            with {djName}
          </span>
        )}
        <span className="v3-caption" style={{ color: 'var(--muted)' }}>
          vol. 1 · transmission {String(transmission ?? 241).padStart(4, '0')}
        </span>
      </div>
      <div
        className="flex items-baseline gap-[18px] v3-caption"
        style={{ color: 'var(--muted)' }}
      >
        <span>
          <span style={{ color: tunedIn ? 'var(--accent)' : 'var(--muted)' }}>●</span>{' '}
          {tunedIn ? 'on air' : 'off air'}
        </span>
        {(city || temp != null || cond) && (
          <span>
            {[city, temp != null ? `${temp}°C` : null, cond].filter(Boolean).join(' · ')}
          </span>
        )}
        <span className="v3-tab-num" style={{ color: 'var(--ink)', fontWeight: 600 }}>
          {time}
        </span>
        {onToggleTicker && (
          <button
            onClick={onToggleTicker}
            className="v3-focus cursor-pointer"
            style={{ color: tickerOn ? 'var(--accent)' : 'var(--muted)' }}
            aria-label={tickerOn ? 'Hide booth feed ticker' : 'Show booth feed ticker'}
            title={tickerOn ? 'Hide booth ticker' : 'Show booth ticker'}
          >
            <Radio className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          onClick={onOpenSettings}
          className="v3-focus cursor-pointer"
          style={{ color: 'var(--ink)' }}
          aria-label="Settings"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
