import AppIntents
import Foundation

// The heart button's App Intent.
//
// Lives in `_shared/` so it compiles into BOTH the widget extension (which
// needs the type to build `Button(intent:)`) and the main app target (which is
// where it actually runs). That split is the whole point of LiveActivityIntent:
// unlike a plain AppIntent, the system performs it in the APP's process,
// waking the app in the background if it is suspended.
//
// Running in the app's process is what lets this stay a one-line intent. It
// does not talk to the station at all — it posts a Darwin-free, in-process
// NotificationCenter message that the Expo module turns into a JS event, and
// the like is then performed by the app's own StationApi client. So the
// station base URL, the SecureStore credentials and the "is this track
// likeable" rule all stay exactly where they already live (src/lib/api.ts,
// credential-vault.ts, useTrackLike.ts) and never enter an extension.
//
// The name is matched across module boundaries by STRING, so the Expo module
// declares its own `Notification.Name` with this same literal. Change one,
// change both (modules/live-activity/ios/SubwaveLiveActivityModule.swift).
@available(iOS 17.0, *)
struct LikeTrackIntent: AppIntent, LiveActivityIntent {
  static var title: LocalizedStringResource = "Like the track on air"
  static var description = IntentDescription(
    "Hearts whatever SUB/WAVE is playing right now, from the Lock Screen, the Dynamic Island or the Apple Watch Smart Stack."
  )

  /// Never foreground the app — the point of the button is that the listener
  /// does not have to open anything.
  static var openAppWhenRun: Bool = false

  func perform() async throws -> some IntentResult {
    NotificationCenter.default.post(
      name: Notification.Name("SubwaveLiveActivityLikePressed"),
      object: nil
    )
    return .result()
  }
}
