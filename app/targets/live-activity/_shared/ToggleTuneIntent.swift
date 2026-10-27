import AppIntents

// The intent behind the tune control (TuneControl.swift): Control Center, the
// Lock Screen and the Action button. A SetValueIntent so ControlWidgetToggle
// can bind to it; the audio and Live Activity conformances do what they do for
// TuneInIntent (TuneIntents.swift): run in the app's process, start playback
// from the background, and let the card start.
//
// Not discoverable: Siri and Shortcuts already have Tune in and Tune out.
@available(iOS 18.0, *)
struct ToggleTuneIntent: SetValueIntent, AudioPlaybackIntent, LiveActivityIntent {
  static var title: LocalizedStringResource = "Turn SUB/WAVE on or off"
  static var isDiscoverable: Bool = false
  static var openAppWhenRun: Bool = false

  @Parameter(title: "On air")
  var value: Bool

  init() {}

  /// A control never resolves parameters, so it must hand over an instance
  /// with `value` already set; left unset, the tap never reaches perform().
  init(turningOn: Bool) {
    self.value = turningOn
  }

  func perform() async throws -> some IntentResult {
    try await SubwaveIntentBridge.perform(value ? "tuneIn" : "tuneOut")
    return .result()
  }
}
