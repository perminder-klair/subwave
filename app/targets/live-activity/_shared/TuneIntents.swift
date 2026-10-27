import AppIntents

// Tune in and tune out, for Siri, Shortcuts, Spotlight and automations.
//
// AudioPlaybackIntent is what lets these run in the APP's process without
// bringing it forward, launching it into the background when it is not
// running: the system grants an audio intent the right to start playback
// from there. The intents themselves only hand the action to JS
// (SubwaveIntentBridge); src/intents/tune.ts decides what tuning in means.
//
// Tune in is a LiveActivityIntent too. ActivityKit refuses a Live Activity
// request from a background app ("Requester is not foreground") unless it
// arrives inside a LiveActivityIntent's run, so without it a tune-in from
// Siri plays with no card on the Lock Screen. tune.ts holds its answer until
// the card has been asked for, keeping the request inside that run.
//
// No skip: every listener shares one live stream. Tune in takes an optional
// saved station (StationEntities.swift); without one it plays the station
// listened to last.
//
// App target only, like SubwaveShortcuts.swift: the widget's control has its
// own ToggleTuneIntent, and StationEntity is app-only.
#if canImport(ExpoModulesCore)

@available(iOS 17.0, *)
struct TuneInIntent: AudioPlaybackIntent, LiveActivityIntent {
  static var title: LocalizedStringResource = "Tune in"
  static var description = IntentDescription(
    "Plays a saved SUB/WAVE station live, or the one you listened to last."
  )
  static var openAppWhenRun: Bool = false

  @Parameter(title: "Station", description: "Leave empty for the station you listened to last.")
  var station: StationEntity?

  func perform() async throws -> some IntentResult {
    try await SubwaveIntentBridge.perform("tuneIn", station.map { ["station": $0.id] } ?? [:])
    return .result()
  }
}

@available(iOS 17.0, *)
struct TuneOutIntent: AudioPlaybackIntent {
  static var title: LocalizedStringResource = "Tune out"
  static var description = IntentDescription("Stops SUB/WAVE.")
  static var openAppWhenRun: Bool = false

  func perform() async throws -> some IntentResult {
    try await SubwaveIntentBridge.perform("tuneOut")
    return .result()
  }
}

#endif
