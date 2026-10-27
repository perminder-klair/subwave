import AppIntents
import SwiftUI
import WidgetKit

// The tune control: Control Center, the Lock Screen, and the Action button on
// an iPhone 15 Pro or later. iOS 18.
//
// A control cannot ask the player whether it is playing, so it reads the
// on-air flag the app keeps in the App Group (usePlayer, through the
// app-intents module's setOnAir). The key and the kind are matched by STRING
// with modules/app-intents/ios/SubwaveAppIntentsModule.swift; change one
// side, change both.
//
// The flag can outlive the audio: an app killed mid-song never clears it. The
// toggle then reads on until it is tapped, which tunes out a stream that has
// already stopped and flips it off, or until the app next launches.

@available(iOS 18.0, *)
struct TuneControl: ControlWidget {
  static let kind = "com.getsubwave.app.tune"

  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: Self.kind, provider: OnAirProvider()) { isOn in
      ControlWidgetToggle(
        "SUB/WAVE", isOn: isOn, action: ToggleTuneIntent(turningOn: !isOn)
      ) { on in
        Label(
          on ? "On air" : "Off air",
          systemImage: on ? "dot.radiowaves.left.and.right" : "radio")
      }
      .tint(Color(red: 0.851, green: 0.294, blue: 0.165))
    }
    .displayName("SUB/WAVE")
    .description("Tune in to the station you listened to last, or tune out.")
  }
}

@available(iOS 18.0, *)
private struct OnAirProvider: ControlValueProvider {
  var previewValue: Bool { false }

  func currentValue() async throws -> Bool {
    UserDefaults(suiteName: subwaveAppGroup)?.bool(forKey: "subwave.onAir") ?? false
  }
}
