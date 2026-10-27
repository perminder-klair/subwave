import ExpoModulesCore
import Foundation
import WidgetKit

// The app half of the App Intents bridge: Siri, Shortcuts and Controls ask,
// JS answers.
//
// The intent half is targets/live-activity/_shared/SubwaveIntentBridge.swift.
// It compiles into the app target (and the widget, which needs the intent
// types for its controls) and cannot import this pod, so the two meet on
// in-process NotificationCenter names, matched by STRING. Change one side,
// change both.
//
// An intent can run before React Native has finished booting: Siri, Shortcuts
// or a Control can launch a killed app straight into the background. So a
// request is acknowledged as soon as this module exists, held until JS
// subscribes, and the intent keeps re-posting until it sees the ack. The work
// itself is all JS (src/intents/), through the same station store, credential
// vault and player the UI uses, which keeps station URLs and credentials out
// of Swift, as LikeTrackIntent does.

private let requestName = Notification.Name("SubwaveIntentRequest")
private let ackName = Notification.Name("SubwaveIntentAck")
private let replyName = Notification.Name("SubwaveIntentReply")

// The tune control's state (targets/live-activity/TuneControl.swift), matched
// by STRING like the names above.
private let appGroup = "group.com.getsubwave.app"
private let onAirKey = "subwave.onAir"
private let tuneControlKind = "com.getsubwave.app.tune"
// The saved stations, read by SavedStations in
// targets/live-activity/_shared/StationEntities.swift, and the app-target class
// that re-indexes them for Spotlight and the Siri phrases with a station in
// them. That code sees the entity types; this pod does not, so it is reached
// by name.
private let stationsKey = "subwave.stations"
private let stationIndexClass = "SubwaveStationIndex"

public class SubwaveAppIntentsModule: Module {
  private var requestObserver: NSObjectProtocol?
  // Main-queue only: the observer delivers there and the JS-thread hooks hop
  // onto it.
  private var listening = false
  private var pending: [[String: Any]] = []
  /// Tokens already taken in. The intent re-posts until it sees an ack, so a
  /// request can arrive more than once.
  private var seen = Set<String>()

  public func definition() -> ModuleDefinition {
    Name("SubwaveAppIntents")

    Events("onIntent")

    OnCreate {
      self.requestObserver = NotificationCenter.default.addObserver(
        forName: requestName,
        object: nil,
        queue: .main
      ) { [weak self] note in
        self?.receive(note.userInfo)
      }
    }

    OnDestroy {
      if let observer = self.requestObserver {
        NotificationCenter.default.removeObserver(observer)
      }
      self.requestObserver = nil
    }

    OnStartObserving {
      DispatchQueue.main.async {
        self.listening = true
        let queued = self.pending
        self.pending = []
        queued.forEach { self.sendEvent("onIntent", $0) }
      }
    }

    OnStopObserving {
      DispatchQueue.main.async {
        self.listening = false
      }
    }

    /// JS's answer to one request. `message` is what Siri says or Shortcuts
    /// shows: the error when `ok` is false, the answer when an intent has one.
    Function("reply") { (token: String, ok: Bool, message: String?) in
      var info: [String: Any] = ["token": token, "ok": ok]
      if let message {
        info["message"] = message
      }
      NotificationCenter.default.post(name: replyName, object: nil, userInfo: info)
    }

    /// Whether the station is on, for the tune control, which cannot ask the
    /// player. Reloads the control only on a change.
    Function("setOnAir") { (onAir: Bool) in
      guard let defaults = UserDefaults(suiteName: appGroup) else { return }
      if defaults.object(forKey: onAirKey) as? Bool == onAir { return }
      defaults.set(onAir, forKey: onAirKey)
      if #available(iOS 18.0, *) {
        ControlCenter.shared.reloadControls(ofKind: tuneControlKind)
      }
    }

    /// The saved stations and the active one, as JSON from JS:
    /// `{ active, stations: [{ id, name }] }`. Names and credential-free bases
    /// only. Writes them for the intents and re-indexes Spotlight.
    Function("setStations") { (json: String) in
      UserDefaults(suiteName: appGroup)?.set(json, forKey: stationsKey)
      if let index: AnyClass = NSClassFromString(stationIndexClass) {
        _ = (index as AnyObject).perform(NSSelectorFromString("reindex"))
      }
    }
  }

  private func receive(_ info: [AnyHashable: Any]?) {
    guard
      let token = info?["token"] as? String,
      let action = info?["action"] as? String
    else { return }
    NotificationCenter.default.post(name: ackName, object: nil, userInfo: ["token": token])
    guard seen.insert(token).inserted else { return }
    let args = info?["args"] as? [String: String] ?? [:]
    let request: [String: Any] = ["token": token, "action": action, "args": args]
    if listening {
      sendEvent("onIntent", request)
    } else {
      pending.append(request)
    }
  }
}
