import CarPlay
import Foundation
import UIKit

// The CarPlay app: the saved stations as a list, and the system Now Playing
// screen once one is tuned in. Present only when the build carries Apple's
// com.apple.developer.carplay-audio entitlement and the CarPlay scene role
// (plugins/withCarPlay.js, SUBWAVE_CARPLAY=1); otherwise these classes are
// never instantiated.
//
// Swift draws, JS decides. The list reads the stations the app mirrors for
// Siri (SavedStations), and a tap hands the station to JS through the same
// bridge Siri's Tune in uses, so switching and tuning in are
// src/intents/tune.ts, and Now Playing is fed by the player as it is for the
// Lock Screen.
//
// App target only, like SubwaveShortcuts.swift.
#if canImport(ExpoModulesCore)
internal import Expo
import React

/// The CarPlay scene. Named in Info.plist by its Objective-C name.
@available(iOSApplicationExtension, unavailable)
@objc(SubwaveCarPlaySceneDelegate)
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  private var interfaceController: CPInterfaceController?
  private var stationsTemplate: CPListTemplate?
  private var observers: [NSObjectProtocol] = []

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController
  ) {
    self.interfaceController = interfaceController
    // The car can launch SUB/WAVE with no phone screen at all, and a station
    // tap needs JS to answer the bridge.
    ReactBoot.startIfNeeded()

    let template = CPListTemplate(title: "Stations", sections: stationSections())
    template.emptyViewTitleVariants = ["No saved stations"]
    template.emptyViewSubtitleVariants = ["Add a station in SUB/WAVE on your iPhone."]
    stationsTemplate = template
    interfaceController.setRootTemplate(template, animated: false, completion: nil)
    configureNowPlaying()

    let center = NotificationCenter.default
    for name in [savedStationsChanged, Notification.Name("SubwaveOnAirChanged")] {
      observers.append(
        center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
          self?.refreshStations()
        })
    }
  }

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnectInterfaceController interfaceController: CPInterfaceController
  ) {
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers = []
    stationsTemplate = nil
    self.interfaceController = nil
  }

  // MARK: - Stations

  private func stationSections() -> [CPListSection] {
    let saved = SavedStations.load()
    let onAir =
      UserDefaults(suiteName: "group.com.getsubwave.app")?.bool(forKey: "subwave.onAir") ?? false
    let icon = UIImage(systemName: "dot.radiowaves.left.and.right")
    let items = saved.stations.map { station -> CPListItem in
      let host = URL(string: station.id)?.host() ?? station.id
      let item = CPListItem(text: station.name, detailText: host, image: icon)
      item.isPlaying = onAir && station.id == saved.active
      item.handler = { [weak self] _, completion in
        self?.tuneIn(station.id, completion: completion)
      }
      return item
    }
    return [CPListSection(items: items)]
  }

  private func refreshStations() {
    stationsTemplate?.updateSections(stationSections())
  }

  /// The row shows a spinner until `completion`, so it is called once the
  /// stream has started or failed, not when the tap lands.
  private func tuneIn(_ stationID: String, completion: @escaping () -> Void) {
    Task { @MainActor in
      do {
        try await SubwaveIntentBridge.perform("tuneIn", ["station": stationID])
        showNowPlaying()
      } catch {
        showAlert((error as? SubwaveIntentError)?.message ?? "SUB/WAVE couldn't tune in.")
      }
      completion()
    }
  }

  // MARK: - Now Playing

  /// The system screen, fed from the player's Now Playing info. No skip or
  /// scrub (one shared live stream); a heart, liked through the same path as
  /// "like this song" from Siri.
  private func configureNowPlaying() {
    let nowPlaying = CPNowPlayingTemplate.shared
    nowPlaying.isUpNextButtonEnabled = false
    nowPlaying.isAlbumArtistButtonEnabled = false
    if let heart = UIImage(systemName: "heart") {
      let like = CPNowPlayingImageButton(image: heart) { _ in
        Task { _ = try? await SubwaveIntentBridge.perform("like") }
      }
      nowPlaying.updateNowPlayingButtons([like])
    }
  }

  private func showNowPlaying() {
    guard let controller = interfaceController,
      !(controller.topTemplate is CPNowPlayingTemplate)
    else { return }
    controller.pushTemplate(CPNowPlayingTemplate.shared, animated: true, completion: nil)
  }

  private func showAlert(_ message: String) {
    guard let controller = interfaceController else { return }
    let ok = CPAlertAction(title: "OK", style: .cancel) { _ in
      controller.dismissTemplate(animated: true, completion: nil)
    }
    controller.presentTemplate(
      CPAlertTemplate(titleVariants: [message], actions: [ok]), animated: true, completion: nil)
  }
}

// MARK: - Starting JS without the phone

/// Under the scene life cycle React Native starts when the phone's window
/// scene connects (ExpoAppSceneDelegate). A launch by the car connects only
/// the CarPlay scene, so the CarPlay delegate starts it here instead, into a
/// window with no scene: the same start the app delegate made before scenes,
/// so expo-updates still chooses the bundle. PhoneSceneDelegate then moves that
/// window onto the phone's scene rather than starting a second copy.
@available(iOSApplicationExtension, unavailable)
@MainActor
enum ReactBoot {
  static func startIfNeeded() {
    guard
      let provider = UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider,
      provider.window == nil,
      let factory = provider.reactNativeFactory
    else { return }
    let window = UIWindow(frame: .zero)
    provider.window = window
    factory.startReactNative(
      withModuleName: provider.reactNativeFactoryModuleName, in: window, launchOptions: nil)
  }
}

/// The phone's window scene: Expo's own, except when React Native is already
/// running in a window with no scene (ReactBoot, or a scene the system
/// disconnected). That window is moved onto this scene, so there is only ever
/// one React tree.
@available(iOSApplicationExtension, unavailable)
@objc(SubwavePhoneSceneDelegate)
final class PhoneSceneDelegate: ExpoAppSceneDelegate {
  override func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard
      let windowScene = scene as? UIWindowScene,
      let provider = UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider,
      let running = provider.window,
      running.windowScene == nil
    else {
      super.scene(scene, willConnectTo: session, options: connectionOptions)
      return
    }
    running.windowScene = windowScene
    window = running
    running.makeKeyAndVisible()

    // What ExpoAppSceneDelegate would forward. React Native was started
    // before this scene existed, so a link that opened the app arrives as an
    // event rather than as Linking.getInitialURL().
    let app = UIApplication.shared
    for context in connectionOptions.urlContexts {
      _ = app.delegate?.application?(app, open: context.url, options: [:])
    }
    for activity in connectionOptions.userActivities {
      _ = app.delegate?.application?(app, continue: activity) { _ in }
    }
  }
}

#endif
