import AppIntents

// App target only, like SubwaveShortcuts.swift: the widget never shows a
// request button, and an intent it also declares could be performed there,
// where nothing answers the bridge.
#if canImport(ExpoModulesCore)

// "Hey Siri, request a song on SUB/WAVE." Siri asks what to play, the request
// goes to the station the listener has tuned to last, and Siri reads back the
// DJ's answer. Hands-free, so it works on AirPods and in the car without a
// CarPlay app.
//
// The request itself is JS (src/intents/request-reply.ts), through the same
// POST /request and polling the request drawer uses, so the station's gates
// (requests closed, rate limits, a full queue) answer Siri in their own words.
@available(iOS 17.0, *)
struct RequestSongIntent: AppIntent {
  static var title: LocalizedStringResource = "Request a song"
  static var description = IntentDescription(
    "Asks the SUB/WAVE DJ for a song, an artist or a mood, and tells you what they said."
  )
  static var openAppWhenRun: Bool = false

  @Parameter(
    title: "Request",
    description: "A song, an artist, or a mood.",
    requestValueDialog: "What would you like to hear?"
  )
  var request: String

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let answer = try await SubwaveIntentBridge.perform("request", ["text": request])
    return .result(dialog: IntentDialog(stringLiteral: answer ?? "Sent to the DJ."))
  }
}

#endif
