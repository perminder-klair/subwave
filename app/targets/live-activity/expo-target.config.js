/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
// The Live Activity widget extension. iOS 18+ mirrors it into the Apple Watch
// Smart Stack, which is SUB/WAVE on the wrist without a watchOS target (#1488).
//
// Deployment target is 17.0, not the app's 16.4: interactive Live Activities
// (the heart, via LiveActivityIntent) are iOS 17+. The module gates every entry
// point on availability, so a 16.x listener just gets no Live Activity.
module.exports = () => ({
  type: 'widget',
  name: 'SUB/WAVE Live',
  displayName: 'SUB/WAVE Live',
  deploymentTarget: '17.0',
  // Same group as the app: cover art exceeds the 4KB content-state budget, so
  // the app writes the JPEG into the shared container and the state carries
  // only its filename.
  entitlements: {
    'com.apple.security.application-groups': ['group.com.getsubwave.app'],
  },
  frameworks: ['SwiftUI', 'WidgetKit', 'ActivityKit', 'AppIntents'],
});
