import SwiftUI
import WidgetKit

// The extension's entry point. Only the Live Activity is exported — this target
// deliberately ships no Home Screen or Lock Screen widget: a widget refreshes on
// WidgetKit's timeline budget (a handful of updates an hour), which would show a
// song that finished twenty minutes ago. The Live Activity is push-updated by
// the app while the listener is actually tuned in, which is the only window
// where "what's on air" can be told truthfully.
@main
struct SubwaveWidgets: WidgetBundle {
  var body: some Widget {
    SubwaveLiveActivity()
  }
}
