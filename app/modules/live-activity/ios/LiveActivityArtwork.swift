import Foundation
import UIKit

// Cover art delivery for the Live Activity.
//
// A widget extension gets no network turn, and a Live Activity content state is
// capped at 4KB — far below any JPEG. So the app downloads the cover, writes it
// into the App Group container, and passes the extension a FILENAME. This file
// is the whole of that arrangement; the widget side is `subwaveArtwork(_:)`.
//
// Everything here is best-effort. A cover that fails to download, a container
// that will not resolve, a disk that is full — none of it may break the
// activity, which is why every entry point returns an optional and no error is
// ever propagated. The disc mark is a perfectly good fallback.
enum LiveActivityArtwork {
  /// Covers held on disk. Small — the activity only ever shows the current
  /// track, and a couple back is enough to survive a station's short loop
  /// without re-downloading. Pruned oldest-first after every write.
  private static let keepCount = 8

  private static var directory: URL? {
    guard
      let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: subwaveAppGroup)
    else { return nil }
    let dir = container.appendingPathComponent("live-activity", isDirectory: true)
    if !FileManager.default.fileExists(atPath: dir.path) {
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    return dir
  }

  /// A subsonic id is opaque and may contain path separators on some servers,
  /// so it is reduced to a filesystem-safe name rather than trusted.
  private static func filename(for key: String) -> String {
    let safe = key.unicodeScalars.map { scalar -> String in
      CharacterSet.alphanumerics.contains(scalar) ? String(scalar) : "-"
    }.joined()
    return String(safe.prefix(64)) + ".img"
  }

  /// The filename for `key` if it is already on disk, else nil. Called on the
  /// hot path so the activity can go out with art immediately when the track
  /// has been seen before, without waiting on a download.
  static func cachedName(for key: String?) -> String? {
    guard let key, !key.isEmpty, let dir = directory else { return nil }
    let name = filename(for: key)
    return FileManager.default.fileExists(atPath: dir.appendingPathComponent(name).path)
      ? name : nil
  }

  /// Download `url` into the shared container under `key`. `completion` fires
  /// with the filename on success and is simply never called with a name on
  /// failure — the caller re-pushes the activity only when art actually landed.
  ///
  /// `headers` carries `Authorization: Basic …` for a credentialed station. The
  /// app passes the same header it already attaches to the audio stream rather
  /// than URL userinfo, which URLSession does not reliably honour (#764 is the
  /// AVPlayer half of the same lesson).
  static func fetch(
    key: String,
    url: String,
    headers: [String: String],
    completion: @escaping (String?) -> Void
  ) {
    guard let dir = directory, let source = URL(string: url) else {
      completion(nil)
      return
    }
    var request = URLRequest(url: source)
    request.timeoutInterval = 12
    for (field, value) in headers {
      request.setValue(value, forHTTPHeaderField: field)
    }
    URLSession.shared.dataTask(with: request) { data, response, _ in
      guard
        let data, !data.isEmpty,
        let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
        // The controller serves a transparent 1x1 placeholder for a missing
        // cover. Decoding proves we got an image at all; the disc mark is a
        // better fallback than a blank square either way.
        UIImage(data: data) != nil
      else {
        completion(nil)
        return
      }
      let name = filename(for: key)
      do {
        try data.write(to: dir.appendingPathComponent(name), options: .atomic)
      } catch {
        completion(nil)
        return
      }
      prune()
      completion(name)
    }.resume()
  }

  /// Drop everything past `keepCount`, oldest first.
  private static func prune() {
    guard let dir = directory else { return }
    let keys: [URLResourceKey] = [.contentModificationDateKey]
    guard
      let files = try? FileManager.default.contentsOfDirectory(
        at: dir, includingPropertiesForKeys: keys, options: .skipsHiddenFiles)
    else { return }
    guard files.count > keepCount else { return }
    let sorted = files.sorted { lhs, rhs in
      let l = (try? lhs.resourceValues(forKeys: [.contentModificationDateKey]))?
        .contentModificationDate ?? .distantPast
      let r = (try? rhs.resourceValues(forKeys: [.contentModificationDateKey]))?
        .contentModificationDate ?? .distantPast
      return l < r
    }
    for url in sorted.prefix(files.count - keepCount) {
      try? FileManager.default.removeItem(at: url)
    }
  }
}
