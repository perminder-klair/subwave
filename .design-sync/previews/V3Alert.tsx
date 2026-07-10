import * as React from 'react';
import { V3Alert } from 'sub-wave-web';

// Sharp bordered inline callout for page-level messages; `tone` is
// "info" (ink) or "error" (vermilion). Mirrors admin DashPanel usage.
export const Info = () => (
  <div style={{ maxWidth: 460 }}>
    <V3Alert title="heads up">
      The stream restarts in about 3 seconds after settings change — listeners
      hear a short gap, then the new encoder settings take effect.
    </V3Alert>
  </div>
);

export const ErrorTone = () => (
  <div style={{ maxWidth: 460 }}>
    <V3Alert tone="error" title="controller error">
      Navidrome is unreachable at http://navidrome:4533 — the auto playlist is
      coasting on the last refresh. Check credentials in Settings.
    </V3Alert>
  </div>
);

export const NoTitle = () => (
  <div style={{ maxWidth: 460 }}>
    <V3Alert>Jingles regenerate in the background; no restart needed.</V3Alert>
  </div>
);
