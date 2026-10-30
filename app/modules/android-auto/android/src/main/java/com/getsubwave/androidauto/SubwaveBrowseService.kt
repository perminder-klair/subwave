package com.getsubwave.androidauto

import android.os.Bundle
import android.support.v4.media.MediaBrowserCompat.MediaItem
import androidx.media.MediaBrowserServiceCompat
import com.doublesymmetry.trackplayer.service.MediaBrowserBridge

/**
 * Android Auto's view of SUB/WAVE: the saved stations, each one playable.
 *
 * Kotlin lists, JS plays. The browse session is the player's own
 * (react-native-track-player), so the car's Now Playing screen, play and pause
 * work as they do on the lock screen. A tap on a station reaches that session,
 * which the RNTP patch (MediaBrowserBridge) turns into a remote-play-id event;
 * service.ts answers it with the tune-in Siri uses (src/intents/tune.ts).
 *
 * The car can bind this with the app not running, and the player's session
 * only exists once JS has set the player up. So the first connection starts
 * React Native and runs the car-connect task (CarConnectTask), and the car's
 * connection completes when the session token arrives.
 */
class SubwaveBrowseService : MediaBrowserServiceCompat() {
  override fun onCreate() {
    super.onCreate()
    current = this
    MediaBrowserBridge.whenSessionReady { token ->
      if (sessionToken == null) sessionToken = token
    }
  }

  override fun onDestroy() {
    current = null
    MediaBrowserBridge.browsing = false
    super.onDestroy()
  }

  override fun onGetRoot(clientPackageName: String, clientUid: Int, rootHints: Bundle?): BrowserRoot? {
    // System UI asks every media app for something to resume after a reboot.
    // A live station has nothing to resume, and answering would start the app
    // in the background on every boot.
    if (rootHints?.getBoolean(BrowserRoot.EXTRA_RECENT) == true) return null
    MediaBrowserBridge.browsing = true
    if (sessionToken == null) CarConnectTask.run(application)
    return BrowserRoot(ROOT, ROOT_EXTRAS)
  }

  override fun onLoadChildren(parentId: String, result: Result<MutableList<MediaItem>>) {
    val items = if (parentId == ROOT) CarStations.load(this).map { it.toMediaItem() } else emptyList()
    result.sendResult(items.toMutableList())
  }

  companion object {
    private const val ROOT = "subwave-root"

    // Stations as a list, not a grid of tiles.
    private val ROOT_EXTRAS = Bundle().apply {
      putBoolean("android.media.browse.CONTENT_STYLE_SUPPORTED", true)
      putInt("android.media.browse.CONTENT_STYLE_PLAYABLE_HINT", 1)
    }

    @Volatile
    private var current: SubwaveBrowseService? = null

    /** Redraws the car's list, when the car is connected. */
    fun stationsChanged() {
      current?.notifyChildrenChanged(ROOT)
    }
  }
}
