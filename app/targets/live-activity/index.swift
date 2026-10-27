import SwiftUI
import WidgetKit

// The extension's entry point: the Live Activity and the tune control. This
// target deliberately ships no Home Screen or Lock Screen widget: a widget
// refreshes on WidgetKit's timeline budget (a handful of updates an hour), which
// would show a song that finished twenty minutes ago. The Live Activity is
// push-updated by the app while the listener is actually tuned in, which is the
// only window where "what's on air" can be told truthfully. The control only
// says whether the station is on, which the app updates as it changes.
@main
struct SubwaveWidgets: WidgetBundle {
  var body: some Widget {
    liveActivity
    if #available(iOS 18.0, *) {
      TuneControl()
    }
  }

  /// Exactly one configuration for SubwaveLiveAttributes: two registered for
  /// the same attributes type leaves which one renders up to the system.
  /// WidgetBundleBuilder only accepts a bare `if #available` (no else), so the
  /// choice is made with explicit returns, each wrapped by the builder's own
  /// functions so both branches are the same type.
  private var liveActivity: some Widget {
    if #available(iOS 18.0, *) {
      return WidgetBundleBuilder.buildOptional(
        WidgetBundleBuilder.buildLimitedAvailability(SubwaveLiveActivityWithSmall()))
    } else {
      return WidgetBundleBuilder.buildOptional(
        WidgetBundleBuilder.buildLimitedAvailability(SubwaveLiveActivity()))
    }
  }
}
