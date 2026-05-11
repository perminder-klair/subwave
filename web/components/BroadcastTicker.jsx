"use client";

import { useMemo, useState } from "react";

const VOICE_KINDS = new Set([
  "dj-speak",
  "station-id",
  "link",
  "hourly-check",
  "weather",
]);

function shortTime(t) {
  try {
    return new Date(t).toLocaleTimeString("en-GB", { hour12: false });
  } catch {
    return "";
  }
}

function Row({ items, duration, direction, opacity, fontSize, paused }) {
  // Tripled so the keyframe can shift one full copy and seamlessly loop.
  const tripled = useMemo(() => [...items, ...items, ...items], [items]);

  return (
    <div className="overflow-hidden" style={{ height: fontSize + 10, opacity }}>
      <div
        className="flex items-center whitespace-nowrap"
        style={{
          animation: `v3-ticker-${direction} ${duration}s linear infinite`,
          animationPlayState: paused ? "paused" : "running",
          willChange: "transform",
          fontSize,
          lineHeight: 1,
          width: "max-content",
        }}
      >
        {tripled.map((e, i) => {
          const isVoice = VOICE_KINDS.has(e.kind);
          return (
            <span
              key={`${e.id ?? "x"}-${i}`}
              className="inline-flex items-baseline"
              style={{ padding: "0 28px" }}
            >
              <span style={{ color: "var(--muted)", marginRight: 10 }}>
                {shortTime(e.t)}
              </span>
              <span
                style={{
                  color: isVoice ? "var(--accent)" : "var(--muted)",
                  letterSpacing: "0.22em",
                  textTransform: "uppercase",
                  fontSize: Math.max(9, fontSize - 4),
                  marginRight: 10,
                  fontWeight: 600,
                }}
              >
                {e.kind}
              </span>
              <span style={{ color: "var(--muted)", marginRight: 8 }}>›</span>
              <span
                style={{
                  color: "var(--ink)",
                  fontStyle: isVoice ? "italic" : "normal",
                  fontFamily: isVoice
                    ? 'Georgia, "Times New Roman", serif'
                    : undefined,
                }}
              >
                {isVoice ? `“${e.message}”` : e.message}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export default function BroadcastTicker({ items, enabled }) {
  const [paused, setPaused] = useState(false);

  // Snapshot the feed only when the newest id changes — otherwise the 5s poll
  // would re-render every tick and visibly restart the marquee.
  const lastId = items && items.length ? items[items.length - 1].id : null;
  const feed = useMemo(() => {
    if (!items?.length) return [];
    return items.slice(-30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId]);

  if (!enabled || feed.length === 0) return null;

  return (
    <div
      className="absolute"
      style={{
        left: 0,
        right: 0,
        top: "66%",
        transform: "translateY(-50%)",
        zIndex: 1,
        maskImage:
          "linear-gradient(to right, transparent 0, black 140px, black calc(100% - 140px), transparent 100%)",
        WebkitMaskImage:
          "linear-gradient(to right, transparent 0, black 140px, black calc(100% - 140px), transparent 100%)",
      }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      aria-hidden="true"
    >
      <Row
        items={feed}
        duration={140}
        direction="left"
        opacity={0.18}
        fontSize={13}
        paused={paused}
      />
      <Row
        items={feed}
        duration={360}
        direction="right"
        opacity={0.3}
        fontSize={20}
        paused={paused}
      />
      <Row
        items={feed}
        duration={160}
        direction="left"
        opacity={0.16}
        fontSize={13}
        paused={paused}
      />
    </div>
  );
}
