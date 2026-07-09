// AVRoutePickerView wrapped as an Expo view — the in-app AirPlay button.
//
// Audio routing itself is system-level: RNTP's AVPlayer output follows
// whatever route the listener picks (Control Center can already do this).
// This view only surfaces the picker inside the app so the feature is
// discoverable. iOS-only by design — Android routing is Google Cast's job.

import AVKit
import ExpoModulesCore

public final class AirplayRoutePickerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AirplayRoutePicker")

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
