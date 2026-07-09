// AVRoutePickerView wrapped as an Expo view — the in-app AirPlay button.
//
// Audio routing itself is system-level: RNTP's AVPlayer output follows
// whatever route the listener picks (Control Center can already do this).
// This view only surfaces the picker inside the app so the feature is
// discoverable. iOS-only by design — Android routing is Google Cast's job.

import AVKit
import ExpoModulesCore

public final class AirplayRoutePickerModule: Module {
  private var routeObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("AirplayRoutePicker")

    // Audio-route changes (AirPlay pick, headphones, speaker fallback) as a JS
    // event: `reason` is AVAudioSession.RouteChangeReason's raw value, and
    // `outputs` the current route, e.g. "AirPlay:HomePod". Used by usePlayer
    // for route-aware reconnect behaviour and diagnostics.
    Events("onAudioRouteChange")

    OnStartObserving {
      self.routeObserver = NotificationCenter.default.addObserver(
        forName: AVAudioSession.routeChangeNotification,
        object: nil,
        queue: .main
      ) { [weak self] note in
        let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) ?? 0
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
          .map { "\($0.portType.rawValue):\($0.portName)" }
          .joined(separator: ",")
        self?.sendEvent("onAudioRouteChange", ["reason": reason, "outputs": outputs])
      }
    }

    OnStopObserving {
      if let observer = self.routeObserver {
        NotificationCenter.default.removeObserver(observer)
        self.routeObserver = nil
      }
    }

    View(AirplayRoutePickerView.self) {
      Prop("tint") { (view: AirplayRoutePickerView, color: UIColor?) in
        view.picker.tintColor = color
      }
      Prop("activeTint") { (view: AirplayRoutePickerView, color: UIColor?) in
        view.picker.activeTintColor = color
      }
    }
  }
}

final class AirplayRoutePickerView: ExpoView {
  let picker = AVRoutePickerView()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    // Audio app: never bias the picker toward video receivers.
    picker.prioritizesVideoDevices = false
    addSubview(picker)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    picker.frame = bounds
  }
}
