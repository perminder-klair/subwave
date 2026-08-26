import ActivityKit
import AppIntents
import SwiftUI
import UIKit
import WidgetKit

// The on-air Live Activity: Lock Screen, Dynamic Island, and — the reason this
// target exists — the Apple Watch Smart Stack, which iOS 18+ mirrors this same
// lock-screen presentation into with no watchOS target of its own.
//
// Everything here renders from the content state alone. A widget extension gets
// no network turn, so nothing in this file fetches: the cover art is read off
// disk from the App Group (the app put it there) and the elapsed clock ticks
// natively off `startedAt` rather than off a stream of updates. That is a
// budget decision as much as a rendering one — ActivityKit rate-limits updates,
// and a per-second push would be throttled away long before the song ended.

// MARK: - Palette

private extension Color {
  /// `#rrggbb` (or `#aarrggbb`) from the station theme. Falls back to the
  /// SUB/WAVE vermilion rather than failing — an activity with no accent is
  /// still a working activity.
  init(subwaveHex hex: String) {
    var value: UInt64 = 0
    let cleaned = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
    guard Scanner(string: cleaned).scanHexInt64(&value), cleaned.count == 6 || cleaned.count == 8 else {
      self = Color(red: 0.851, green: 0.294, blue: 0.165)
      return
    }
    let hasAlpha = cleaned.count == 8
    let r = Double((value >> 16) & 0xFF) / 255
    let g = Double((value >> 8) & 0xFF) / 255
    let b = Double(value & 0xFF) / 255
    let a = hasAlpha ? Double((value >> 24) & 0xFF) / 255 : 1
    self = Color(.sRGB, red: r, green: g, blue: b, opacity: a)
  }
}

/// The dark half of the app's default palette (global.css). A Live Activity is
/// always drawn over the Lock Screen's dark material, so it does not follow the
/// light theme even when the phone is in light mode.
private let subwaveInk = Color(.sRGB, red: 0.925, green: 0.902, blue: 0.863, opacity: 1)
private let subwaveMuted = Color(.sRGB, red: 0.757, green: 0.753, blue: 0.741, opacity: 1)

// MARK: - Artwork

/// Cover art the app wrote into the shared container, or nil. Reading a file
/// the app may be mid-write on is why this is failable at every step rather
/// than force-unwrapped: a missing cover falls back to the disc mark.
private func subwaveArtwork(_ name: String?) -> UIImage? {
  guard let name, !name.isEmpty else { return nil }
  guard
    let container = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: subwaveAppGroup)
  else { return nil }
  let url = container.appendingPathComponent("live-activity", isDirectory: true)
    .appendingPathComponent(name)
  return UIImage(contentsOfFile: url.path)
}

/// The station's disc mark, drawn rather than bundled so it takes the station's
/// own accent. Stands in for a cover the controller has none of (a jingle, a
/// spoken segment) or one that has not landed yet.
private struct DiscMark: View {
  let accent: Color

  var body: some View {
    GeometryReader { geo in
      let side = min(geo.size.width, geo.size.height)
      ZStack {
        Circle().fill(Color.black.opacity(0.45))
        Circle().strokeBorder(accent.opacity(0.85), lineWidth: side * 0.06)
          .padding(side * 0.12)
        Circle().fill(accent).frame(width: side * 0.18, height: side * 0.18)
      }
      .frame(width: side, height: side)
    }
    .aspectRatio(1, contentMode: .fit)
  }
}

private struct Cover: View {
  let state: SubwaveLiveAttributes.ContentState
  let accent: Color
  var side: CGFloat = 54

  var body: some View {
    Group {
      if let image = subwaveArtwork(state.artwork) {
        Image(uiImage: image)
          .resizable()
          .aspectRatio(contentMode: .fill)
      } else {
        DiscMark(accent: accent)
      }
    }
    .frame(width: side, height: side)
    .clipShape(RoundedRectangle(cornerRadius: side * 0.16, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: side * 0.16, style: .continuous)
        .strokeBorder(Color.white.opacity(0.10), lineWidth: 0.5)
    )
  }
}

// MARK: - Pieces

/// The station eyebrow: a pulseless accent dot plus the station name, set in
/// the mono/eyebrow style the player uses everywhere. No animation — a Live
/// Activity is a static snapshot between updates, so a "pulsing" dot would just
/// sit still and read as broken.
private struct OnAirLine: View {
  let station: String
  let accent: Color

  var body: some View {
    HStack(spacing: 5) {
      Circle().fill(accent).frame(width: 5, height: 5)
      Text(station.uppercased())
        .font(.system(size: 9, weight: .semibold, design: .monospaced))
        .tracking(1.4)
        .foregroundStyle(subwaveMuted)
        .lineLimit(1)
    }
  }
}

/// Elapsed/remaining for the song. Prefers a natively-ticking bar when the
/// track's length is known; falls back to a bare running clock when it is not
/// (voice segments and jingles carry no duration).
private struct AirClock: View {
  let state: SubwaveLiveAttributes.ContentState
  let accent: Color
  var compact = false

  private var window: ClosedRange<Date>? {
    guard let start = state.startedAt, let duration = state.duration, duration > 1 else {
      return nil
    }
    return start...start.addingTimeInterval(duration)
  }

  var body: some View {
    if let window {
      ProgressView(timerInterval: window, countsDown: false) {
        EmptyView()
      } currentValueLabel: {
        EmptyView()
      }
      .progressViewStyle(.linear)
      .tint(accent)
      .labelsHidden()
    } else if let start = state.startedAt {
      Text(start, style: .timer)
        .font(.system(size: compact ? 12 : 11, weight: .medium, design: .monospaced))
        .foregroundStyle(subwaveMuted)
        .monospacedDigit()
    } else {
      Text("LIVE")
        .font(.system(size: compact ? 12 : 10, weight: .semibold, design: .monospaced))
        .tracking(1.2)
        .foregroundStyle(accent)
    }
  }
}

/// The heart. Hidden entirely unless the controller says this airing is
/// likeable — jingles and spoken segments have no id to like, and a station can
/// turn likes off, in which case the button must not exist rather than fail.
///
/// Tapping runs LikeTrackIntent in the APP's process (see _shared/), which
/// hands the tap to JS; the filled state arrives on the next feed poll, so
/// expect up to ~5s before the count moves. Optimism is deliberately not faked
/// here — the controller rejects a stale tap, and a heart that fills and then
/// un-fills is worse than one that fills a beat late.
@available(iOS 17.0, *)
private struct LikeButton: View {
  let state: SubwaveLiveAttributes.ContentState
  let accent: Color

  var body: some View {
    if state.likeable {
      Button(intent: LikeTrackIntent()) {
        VStack(spacing: 1) {
          Image(systemName: state.liked ? "heart.fill" : "heart")
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(state.liked ? accent : subwaveMuted)
          if state.likeCount > 0 {
            Text("\(state.likeCount)")
              .font(.system(size: 9, weight: .medium, design: .monospaced))
              .foregroundStyle(subwaveMuted)
          }
        }
        .frame(minWidth: 30)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(state.liked)
    }
  }
}

/// Title + artist. While the DJ is mid-link the controller has already swapped
/// these for the persona, matching what the lock screen shows (useNowPlayingInfo).
private struct TrackLines: View {
  let state: SubwaveLiveAttributes.ContentState

  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(state.title)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(subwaveInk)
        .lineLimit(1)
      Text(state.artist)
        .font(.system(size: 12, weight: .regular))
        .foregroundStyle(subwaveMuted)
        .lineLimit(1)
    }
  }
}

// MARK: - Lock Screen / Smart Stack

/// Also the Apple Watch presentation: watchOS renders the Smart Stack card from
/// this same view, at a narrower width. Keep it a single row that degrades — no
/// fixed widths, everything `lineLimit(1)`.
private struct LockScreenView: View {
  let context: ActivityViewContext<SubwaveLiveAttributes>

  private var accent: Color { Color(subwaveHex: context.attributes.accent) }

  var body: some View {
    HStack(alignment: .center, spacing: 11) {
      Cover(state: context.state, accent: accent)
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 6) {
          OnAirLine(station: context.attributes.station, accent: accent)
          if let show = context.state.show, !show.isEmpty {
            Text(show)
              .font(.system(size: 9, weight: .medium, design: .monospaced))
              .tracking(1.0)
              .foregroundStyle(subwaveMuted.opacity(0.75))
              .lineLimit(1)
          }
        }
        TrackLines(state: context.state)
        AirClock(state: context.state, accent: accent)
      }
      if #available(iOS 17.0, *) {
        LikeButton(state: context.state, accent: accent)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
  }
}

// MARK: - Widget

struct SubwaveLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: SubwaveLiveAttributes.self) { context in
      LockScreenView(context: context)
        .widgetURL(URL(string: "subwave://"))
        .activityBackgroundTint(Color.black.opacity(0.55))
        .activitySystemActionForegroundColor(subwaveInk)
    } dynamicIsland: { context in
      let accent = Color(subwaveHex: context.attributes.accent)
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Cover(state: context.state, accent: accent, side: 44)
        }
        DynamicIslandExpandedRegion(.trailing) {
          if #available(iOS 17.0, *) {
            LikeButton(state: context.state, accent: accent)
          }
        }
        DynamicIslandExpandedRegion(.center) {
          VStack(alignment: .leading, spacing: 3) {
            OnAirLine(station: context.attributes.station, accent: accent)
            TrackLines(state: context.state)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        DynamicIslandExpandedRegion(.bottom) {
          AirClock(state: context.state, accent: accent)
        }
      } compactLeading: {
        Cover(state: context.state, accent: accent, side: 18)
      } compactTrailing: {
        AirClock(state: context.state, accent: accent, compact: true)
          .frame(maxWidth: 44)
      } minimal: {
        DiscMark(accent: accent).frame(width: 18, height: 18)
      }
      .widgetURL(URL(string: "subwave://"))
      .keylineTint(accent)
    }
  }
}

// MARK: - Previews

extension SubwaveLiveAttributes {
  fileprivate static var preview: SubwaveLiveAttributes {
    SubwaveLiveAttributes(station: "SUB/WAVE", accent: "#d94b2a")
  }
}

extension SubwaveLiveAttributes.ContentState {
  fileprivate static var song: SubwaveLiveAttributes.ContentState {
    .init(
      title: "Tape Hiss Cathedral", artist: "Low Ceiling Club", show: "NIGHT SHIFT",
      artwork: nil, startedAt: Date().addingTimeInterval(-71), duration: 244,
      talking: false, likeCount: 12, liked: false, likeable: true)
  }

  fileprivate static var talking: SubwaveLiveAttributes.ContentState {
    .init(
      title: "VELA", artist: "on the mic", show: "NIGHT SHIFT",
      artwork: nil, startedAt: Date(), duration: nil,
      talking: true, likeCount: 0, liked: false, likeable: false)
  }
}

#Preview("Live Activity", as: .content, using: SubwaveLiveAttributes.preview) {
  SubwaveLiveActivity()
} contentStates: {
  SubwaveLiveAttributes.ContentState.song
  SubwaveLiveAttributes.ContentState.talking
}
