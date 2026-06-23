// Crash / error / ANR reporting via the Sentry SDK, pointed at a GlitchTip
// project (GlitchTip is Sentry-API compatible — same SDK, your own DSN).
//
// Deliberately minimal and privacy-first, because SUB/WAVE is self-hosted and
// tracking-free by design: NO performance tracing, NO session replay, NO usage
// analytics, NO PII. The only goal is to capture the *technical fault* when the
// app crashes, throws, or the main thread hangs (ANR), so device-specific
// failures like the Android dead-UI (issue #458) self-report the actual cause
// instead of needing a hand-run `adb logcat`.
//
// Notably we do NOT call Sentry.wrap(): its TouchEventBoundary instruments the
// root touch responder for breadcrumbs, and adding another touch-observing
// wrapper into an app we're debugging *for a touch-routing bug* is exactly the
// confound to avoid. Sentry.init() alone still installs the native crash
// handler, Android ANR detection, and the global unhandled-JS-error hook —
// which is the signal we need.
//
// DSN comes from EXPO_PUBLIC_GLITCHTIP_DSN at build time. When unset (dev, or
// builds we don't want instrumented), init is skipped and every Sentry call is
// a no-op.

import * as Sentry from '@sentry/react-native';

const dsn = process.env.EXPO_PUBLIC_GLITCHTIP_DSN;

export const observabilityEnabled = !!dsn;

if (dsn) {
  Sentry.init({
    dsn,
    // Error/crash/ANR only — GlitchTip doesn't do tracing/replay, and we don't
    // want them anyway.
    tracesSampleRate: 0,
    enableAutoSessionTracking: false, // no release-health / usage sessions
    sendDefaultPii: false, // no IP address or user identifiers
    attachStacktrace: true,
    // Native crash handling + Android ANR capture stay on (SDK defaults); the
    // silent-freeze reports (#458) are exactly the ANR case we want to catch.
  });
}

export { Sentry };
