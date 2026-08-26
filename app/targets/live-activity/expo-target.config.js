/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
// The Live Activity widget extension.
//
// This target exists for ONE reason the OS media controls can't cover: iOS 18+
// mirrors an iPhone Live Activity into the Apple Watch Smart Stack, so this is
// SUB/WAVE on the wrist without a watchOS target (React Native does not run on
// watchOS — a real watch app is a second, Swift-only codebase; see #1488).
//
// Deployment target is 17.0, not the app's 16.4: interactive Live Activities
// (the heart button, via LiveActivityIntent) are iOS 17+, and the Smart Stack
// mirroring this target is built for is iOS 18+ anyway. The module gates every
// entry point on availability, so a 16.x listener simply gets no Live Activity
// and the lock screen / Now Playing path is unchanged.
module.exports = () => ({
  type: 'widget',
  name: 'SUB/WAVE Live',
  displayName: 'SUB/WAVE Live',
  deploymentTarget: '17.0',
  // Same group as the app: cover art is too big for the 4KB content-state
  // budget, so the app writes the JPEG into the shared container and the
  // content state carries only its filename (see LiveActivityArtwork.swift).
  entitlements: {
    'com.apple.security.application-groups': ['group.com.getsubwave.app'],
  },
  frameworks: ['SwiftUI', 'WidgetKit', 'ActivityKit', 'AppIntents'],
});
