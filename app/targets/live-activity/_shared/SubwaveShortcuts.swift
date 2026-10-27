import AppIntents

// App target only. `_shared/` also compiles into the widget extension, and a
// second AppShortcutsProvider there sends Shortcuts to the wrong bundle for a
// shortcut with a parameter to ask for: "Couldn't find AppShortcutsProvider".
// Only the app target links the Expo pods, which is what this tests; if the
// widget ever joins the Podfile, find another switch.
#if canImport(ExpoModulesCore)

/// Siri phrases. Every phrase must carry the app's name; "Sub Wave" and
/// "Subwave" reach it through INAlternativeAppNames (app.json), since nobody
/// says the slash. A free-text parameter cannot be part of a phrase, so a
/// request is asked for after the phrase (RequestSongIntent's dialog).
@available(iOS 17.0, *)
struct SubwaveShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: TuneInIntent(),
      phrases: [
        "Tune in to \(.applicationName)",
        "Play \(.applicationName)",
        "Turn on \(.applicationName)",
        "Start \(.applicationName)",
        // A saved station by name. The names come from StationQuery's
        // suggestions, refreshed by StationIndex.reindex.
        "Play \(\.$station) on \(.applicationName)",
        "Tune in to \(\.$station) on \(.applicationName)",
        "Listen to \(\.$station) on \(.applicationName)",
      ],
      shortTitle: "Tune in",
      systemImageName: "dot.radiowaves.left.and.right"
    )
    AppShortcut(
      intent: TuneOutIntent(),
      phrases: [
        "Tune out of \(.applicationName)",
        "Stop \(.applicationName)",
        "Turn off \(.applicationName)",
      ],
      shortTitle: "Tune out",
      systemImageName: "stop.fill"
    )
    AppShortcut(
      intent: RequestSongIntent(),
      phrases: [
        "Request a song on \(.applicationName)",
        "Make a request on \(.applicationName)",
        "Ask \(.applicationName) for a song",
      ],
      shortTitle: "Request a song",
      systemImageName: "music.note"
    )
    AppShortcut(
      intent: WhatsPlayingIntent(),
      phrases: [
        "What's playing on \(.applicationName)",
        "What's on \(.applicationName)",
        "What song is this on \(.applicationName)",
      ],
      shortTitle: "What's playing",
      systemImageName: "waveform"
    )
    AppShortcut(
      intent: LikeSongIntent(),
      phrases: [
        "Like this song on \(.applicationName)",
        "Like this track on \(.applicationName)",
        "Heart this song on \(.applicationName)",
      ],
      shortTitle: "Like this song",
      systemImageName: "heart"
    )
  }
}

#endif
