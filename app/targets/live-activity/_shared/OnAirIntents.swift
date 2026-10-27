import AppIntents

// App target only, like SubwaveShortcuts.swift: an intent the widget also
// declared could be performed there, where nothing answers the bridge.
#if canImport(ExpoModulesCore)

// "What's playing on SUB/WAVE" and "like this song on SUB/WAVE". Both mean the
// track the listener is hearing, which src/intents/on-air.ts works out: while
// the app is playing, the stream runs behind the live edge, and for that long
// after a change the song in their ears is the previous one.

@available(iOS 17.0, *)
struct WhatsPlayingIntent: AppIntent {
  static var title: LocalizedStringResource = "What's playing"
  static var description = IntentDescription(
    "Tells you the song on SUB/WAVE: the one you're hearing when you're tuned in."
  )
  static var openAppWhenRun: Bool = false

  func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
    let answer = try await SubwaveIntentBridge.perform("nowPlaying") ?? ""
    return .result(value: answer, dialog: IntentDialog(stringLiteral: answer))
  }
}

/// Hearts the song through the station's own POST /like, which refuses a
/// song that has already ended. The Live Activity's button is
/// LikeTrackIntent, which likes through the in-app heart instead.
@available(iOS 17.0, *)
struct LikeSongIntent: AppIntent {
  static var title: LocalizedStringResource = "Like this song"
  static var description = IntentDescription(
    "Hearts the song you're hearing on SUB/WAVE."
  )
  static var openAppWhenRun: Bool = false

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let answer = try await SubwaveIntentBridge.perform("like") ?? "Liked."
    return .result(dialog: IntentDialog(stringLiteral: answer))
  }
}

#endif
