import AppIntents

// "Hey Siri, play SUB/WAVE" on iOS 27.
//
// iOS 27 sends a bare "play <app>" through Siri's audio search, and an app
// that has not adopted the audio App Schema loses it to Apple Music, App
// Shortcut phrase or not (WXYC's radio app hit exactly this on iOS 27.0.1).
// Adopting it takes three pieces: a `.audio.liveRadioStation` entity, a query
// that answers Siri's AudioSearch (`IntentValueQuery`: a bare "play SUB/WAVE"
// arrives as `.unspecified`, which a string query never sees), and a
// `.audio.playAudio` intent, which tunes in exactly as TuneInIntent does.
//
// One entity per saved station (SavedStations, StationEntities.swift), so
// "play Night Shift on SUB/WAVE" reaches that station; a bare "play SUB/WAVE"
// is the station listened to last.
//
// Gated on Swift 6.4 (the iOS 27 SDK), where these schema symbols exist; an
// older Xcode compiles this out and "play SUB/WAVE" stays on the App Shortcut
// phrase. App target only, like SubwaveShortcuts.swift.
#if compiler(>=6.4) && canImport(ExpoModulesCore)
#if canImport(MediaIntents)
import MediaIntents
#endif

@available(iOS 27.0, *)
@AppEntity(schema: .audio.liveRadioStation)
struct LiveStationEntity {
  static let defaultQuery = LiveStationQuery()
  /// The stand-in before the app has saved a station: playing it says to
  /// pick one first.
  static let noStationID = "none"

  /// A saved station's credential-free base (StationEntities.swift).
  let id: String
  /// What Siri says back: the station's own name.
  var title: String
  var providerName: String?

  init(_ station: SavedStations.Station) {
    self.id = station.id
    self.title = station.name
    self.providerName = "SUB/WAVE"
  }

  init() {
    self.id = Self.noStationID
    self.title = "SUB/WAVE"
    self.providerName = "SUB/WAVE"
  }

  /// The station listened to last, or the stand-in.
  static func active(_ saved: SavedStations = .load()) -> LiveStationEntity {
    saved.activeStation.map(LiveStationEntity.init) ?? LiveStationEntity()
  }

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(title)")
  }
}

@available(iOS 27.0, *)
struct LiveStationQuery: EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [LiveStationEntity] {
    var found = SavedStations.load().stations
      .filter { identifiers.contains($0.id) }
      .map(LiveStationEntity.init)
    if identifiers.contains(LiveStationEntity.noStationID) { found.append(LiveStationEntity()) }
    return found
  }

  /// Shortcuts' text search, typed against every entity type the app has: a
  /// saved station's name, or the app's own for the station listened to last.
  func entities(matching string: String) async throws -> [LiveStationEntity] {
    let saved = SavedStations.load()
    let named = saved.matching(string).map(LiveStationEntity.init)
    if !named.isEmpty { return named }
    let term = string.trimmingCharacters(in: .whitespaces)
    let appNames = ["SUB/WAVE", "subwave", "sub wave"]
    let namesApp = !term.isEmpty
      && appNames.contains { $0.localizedStandardContains(term) || term.localizedStandardContains($0) }
    return namesApp ? [LiveStationEntity.active(saved)] : []
  }

  func suggestedEntities() async throws -> [LiveStationEntity] {
    let saved = SavedStations.load()
    return saved.stations.isEmpty ? [LiveStationEntity()] : saved.stations.map(LiveStationEntity.init)
  }
}

#if canImport(MediaIntents)
/// Siri's audio search, consulted once Siri has chosen SUB/WAVE. `.unspecified`
/// is "play SUB/WAVE" and nothing else: the station listened to last.
/// `.searchQuery` is whatever words were left over: a saved station they name,
/// else the station listened to last, since a word like "radio" or a song
/// title should still tune in rather than come back "not found". A link is
/// never claimed: a station lives at the listener's own host.
@available(iOS 27.0, *)
extension LiveStationQuery: IntentValueQuery {
  func values(for search: AudioSearch) async throws -> [LiveStationEntity] {
    let saved = SavedStations.load()
    switch search.criteria {
    case .unspecified:
      return [LiveStationEntity.active(saved)]
    case .searchQuery(let words):
      let named = saved.matching(words).map(LiveStationEntity.init)
      return named.isEmpty ? [LiveStationEntity.active(saved)] : named
    case .url:
      return []
    @unknown default:
      return []
    }
  }
}
#endif

@available(iOS 27.0, *)
@UnionValue
enum AudioItem {
  case liveRadioStation(LiveStationEntity)
}

/// Required by the schema. A live stream has no shuffle or repeat, so these
/// are accepted and ignored.
@available(iOS 27.0, *)
@AppEnum(schema: .audio.playbackAttributes)
enum PlaybackAttributes: String {
  case shuffle
  case `repeat`

  static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
    .shuffle: "Shuffle",
    .repeat: "Repeat",
  ]
}

/// Required by the schema; there is no queue to insert into.
@available(iOS 27.0, *)
@AppEnum(schema: .audio.queueInsertionLocation)
enum QueueInsertionLocation: String {
  case next
  case tail

  static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
    .next: "Next",
    .tail: "Tail",
  ]
}

/// Required by the schema; SUB/WAVE has nothing to warm up.
@available(iOS 27.0, *)
@AppEntity(schema: .audio.warmupAudioQueueResult)
struct WarmupAudioQueueResult: TransientAppEntity {
  init() {}

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "Queue")
  }
}

/// Assistant-only: Shortcuts already lists Tune in, and a schema intent beside
/// an App Shortcut for the same action shows as a duplicate there.
/// LiveActivityIntent for the same reason as TuneInIntent: the card can only
/// start inside its run.
@available(iOS 27.0, *)
@AppIntent(schema: .audio.playAudio)
struct PlayStationAudioIntent: AudioPlaybackIntent, LiveActivityIntent {
  static let isAssistantOnly = true

  var audioEntity: AudioItem
  var playbackAttributes: Set<PlaybackAttributes>
  var warmupAudioQueueResult: WarmupAudioQueueResult?
  var queueLocation: QueueInsertionLocation?

  func perform() async throws -> some IntentResult {
    switch audioEntity {
    case .liveRadioStation(let station):
      let args = station.id == LiveStationEntity.noStationID ? [:] : ["station": station.id]
      try await SubwaveIntentBridge.perform("tuneIn", args)
    }
    return .result()
  }
}

#endif
