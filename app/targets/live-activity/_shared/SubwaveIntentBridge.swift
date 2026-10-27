import AppIntents
import Foundation

// The intent half of the App Intents bridge. An intent hands its action to JS
// and waits for the answer; the app half is
// modules/app-intents/ios/SubwaveAppIntentsModule.swift, which this file
// cannot import (it compiles into the widget extension too), so the two meet
// on NotificationCenter names, matched by STRING. Change one side, change both.
//
// Only meaningful in the APP's process. Every intent that uses it must be one
// the system runs there (AudioPlaybackIntent, LiveActivityIntent): in the
// widget extension nothing is listening and `perform` fails after the ack
// window.

@available(iOS 17.0, *)
enum SubwaveIntentBridge {
  private static let requestName = Notification.Name("SubwaveIntentRequest")
  private static let ackName = Notification.Name("SubwaveIntentAck")
  private static let replyName = Notification.Name("SubwaveIntentReply")

  /// How long a cold launch gets for React Native to boot far enough to load
  /// the module.
  private static let ackWindow: TimeInterval = 10
  /// Ceiling on the whole round trip, ack included. A tune-in waits for the
  /// stream to start playing, so this covers a slow first connection.
  private static let replyWindow: TimeInterval = 20

  /// Runs `action` in JS with `args`. Returns the message JS answered with, if
  /// any; throws the message JS gave for a failure, or a generic one when the
  /// app never answered.
  @discardableResult
  static func perform(_ action: String, _ args: [String: String] = [:]) async throws -> String? {
    let token = UUID().uuidString
    let box = ReplyBox()
    let center = NotificationCenter.default
    let ackObserver = center.addObserver(forName: ackName, object: nil, queue: nil) { note in
      if note.userInfo?["token"] as? String == token { box.markAcked() }
    }
    let replyObserver = center.addObserver(forName: replyName, object: nil, queue: nil) { note in
      guard note.userInfo?["token"] as? String == token else { return }
      box.resolve(
        ok: note.userInfo?["ok"] as? Bool ?? false,
        message: note.userInfo?["message"] as? String)
    }
    defer {
      center.removeObserver(ackObserver)
      center.removeObserver(replyObserver)
    }

    let started = Date()
    while true {
      if let reply = box.reply {
        guard reply.ok else { throw SubwaveIntentError(reply.message) }
        return reply.message
      }
      let waited = Date().timeIntervalSince(started)
      if waited > replyWindow || (!box.acked && waited > ackWindow) {
        throw SubwaveIntentError(nil)
      }
      if !box.acked {
        center.post(
          name: requestName, object: nil,
          userInfo: ["token": token, "action": action, "args": args])
      }
      try await Task.sleep(nanoseconds: 200_000_000)
    }
  }
}

/// Written from NotificationCenter's posting thread, read from the intent's.
private final class ReplyBox: @unchecked Sendable {
  struct Reply {
    let ok: Bool
    let message: String?
  }

  private let lock = NSLock()
  private var _acked = false
  private var _reply: Reply?

  var acked: Bool {
    lock.lock()
    defer { lock.unlock() }
    return _acked
  }

  var reply: Reply? {
    lock.lock()
    defer { lock.unlock() }
    return _reply
  }

  func markAcked() {
    lock.lock()
    _acked = true
    lock.unlock()
  }

  func resolve(ok: Bool, message: String?) {
    lock.lock()
    _acked = true
    if _reply == nil {
      _reply = Reply(ok: ok, message: message)
    }
    lock.unlock()
  }
}

/// What Siri says, and Shortcuts shows, when an intent could not do its job.
struct SubwaveIntentError: Error, CustomLocalizedStringResourceConvertible {
  let message: String

  init(_ message: String?) {
    self.message = message ?? "SUB/WAVE didn't respond. Open the app and try again."
  }

  var localizedStringResource: LocalizedStringResource {
    LocalizedStringResource(stringLiteral: message)
  }
}
