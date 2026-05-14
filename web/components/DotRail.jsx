'use client';

import { isValidElement } from 'react';

const ITEMS = [
  { k: 'queue',   l: 'Queue' },
  { k: 'history', l: 'Played' },
  { k: 'booth',   l: 'Booth' },
  { k: 'request', l: 'Request' },
];

export default function DotRail({ counts, active, onSelect }) {
  return (
    <div
      className="absolute z-20 flex flex-col items-center justify-center sm:[border-left:1px_solid_var(--ink)]"
      style={{
        top: 80,
        right: 0,
        bottom: 80,
        width: 96,
        gap: 4,
      }}
    >
      {ITEMS.map(item => {
        const isActive = active === item.k;
        const isRequest = item.k === 'request';
        const n = isRequest ? '+' : (counts?.[item.k] ?? 0);
        const isIcon = isValidElement(n);
        return (
          <button
            key={item.k}
            onClick={() => onSelect(isActive ? null : item.k)}
            className="w-full flex flex-col items-center gap-[6px] cursor-pointer v3-focus"
            style={{
              background: isActive
                ? 'var(--ink)'
                : isRequest
                  ? 'rgba(197, 48, 42, 0.08)'
                  : 'transparent',
              color: isActive ? 'var(--bg)' : 'var(--ink)',
              border: 'none',
              padding: '14px 8px',
              fontFamily: 'inherit',
              boxShadow: isRequest && !isActive
                ? 'inset 2px 0 0 var(--accent)'
                : undefined,
            }}
            aria-pressed={isActive}
          >
            <span
              className="v3-tab-num"
              style={{
                fontSize: isRequest ? 26 : 22,
                fontWeight: isRequest ? 600 : 200,
                lineHeight: 1,
                display: isIcon ? 'inline-flex' : undefined,
                alignItems: isIcon ? 'center' : undefined,
                justifyContent: isIcon ? 'center' : undefined,
                height: isIcon ? 22 : undefined,
                color: isActive
                  ? 'var(--accent)'
                  : isRequest
                    ? 'var(--accent)'
                    : 'var(--ink)',
              }}
            >
              {n}
            </span>
            <span
              style={{
                fontSize: 9,
                letterSpacing: '0.3em',
                textTransform: 'uppercase',
                color: isActive
                  ? 'var(--bg)'
                  : isRequest
                    ? 'var(--accent)'
                    : 'var(--ink)',
                fontWeight: isRequest ? 700 : 'inherit',
              }}
            >
              {item.l}
            </span>
          </button>
        );
      })}
    </div>
  );
}
