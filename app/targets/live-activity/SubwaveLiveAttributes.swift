import ActivityKit
import Foundation

// The Live Activity's data contract.
//
// DUPLICATED, DELIBERATELY. This exact file also lives at
// modules/live-activity/ios/SubwaveLiveAttributes.swift. The widget extension
// and the Expo module compile into different Swift modules and neither can
// import the other, so ActivityKit's own guidance applies: ship the same source
// to both targets. ActivityKit matches an activity to its widget by the
// attributes type NAME, not its module, which is why two compiled copies work
// (it is the same split Apple's own template has between app and extension).
//
// The two copies must stay byte-identical — scripts/live-activity-attributes.test.ts
// fails the build if they drift, the same drift guard the controller runs over
// its zod schema mirror. Never edit one without the other.

/// App Group shared by the app and this extension. Cover art travels through
/// its container because a Live Activity content state is capped at 4KB —
/// nowhere near a JPEG — so the state carries a filename instead.
let subwaveAppGroup = "group.com.getsubwave.app"

struct SubwaveLiveAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    /// Track title, or the persona's name while the DJ is talking.
    var title: String
    /// Artist, or the show name while the DJ is talking.
    var artist: String
    /// Show/persona line, e.g. "Night Shift". Absent outside a scheduled show.
    var show: String?
    /// Filename (not a path) inside the App Group's artwork directory. The
    /// extension cannot fetch a remote URL — widget code gets no network turn —
    /// so the app downloads the cover and passes the name it wrote.
    var artwork: String?
    /// When this track became audible TO THIS LISTENER — the live-edge stamp
    /// already shifted by stream.bufferSeconds (useStationFeed owns that
    /// offset). SwiftUI ticks the clock off this natively, so the activity
    /// stays honest for the whole song on ONE update rather than one a second.
    var startedAt: Date?
    /// Track length in seconds. Absent/0 for anything unmeasured (a voice
    /// segment, a jingle) — the view falls back to a bare LIVE marker.
    var duration: Double?
    /// The DJ is mid-link. Swaps the strip to the persona, like the lock screen.
    var talking: Bool
    /// Likes for the current song, all airings.
    var likeCount: Int
    /// This listener already liked the current airing.
    var liked: Bool
    /// Present only when a likeable track is on air AND the station has likes
    /// enabled. Absent hides the heart — jingles and spoken segments carry no
    /// id, and there is nothing to like.
    var likeable: Bool
  }

  /// Station display name, fixed for the life of the activity. A station switch
  /// tears playback down, which ends the activity.
  var station: String
  /// The station theme's accent as `#rrggbb`, sampled when the activity starts.
  /// A theme change mid-listen lands on the next tune-in, not this activity —
  /// ActivityKit attributes are immutable by design.
  var accent: String
}
