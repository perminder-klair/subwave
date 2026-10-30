package com.getsubwave.androidauto

import android.app.Application
import androidx.annotation.MainThread
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext

/**
 * Runs JS's car-connect task, which sets the player up so its session exists
 * for the car (src/intents/car.ts). Starts React Native first when the car is
 * what launched the app: there is no activity, so nothing else will.
 */
internal object CarConnectTask {
  // Matched by STRING with src/intents/car.ts.
  private const val TASK = "SubwaveCarConnect"
  private const val TIMEOUT_MS = 30_000L

  private var starting = false

  @MainThread
  fun run(app: Application) {
    val host = (app as? ReactApplication)?.reactHost ?: return
    host.currentReactContext?.let {
      start(it)
      return
    }
    if (starting) return
    starting = true
    host.addReactInstanceEventListener(object : ReactInstanceEventListener {
      override fun onReactContextInitialized(context: ReactContext) {
        host.removeReactInstanceEventListener(this)
        UiThreadUtil.runOnUiThread {
          starting = false
          start(context)
        }
      }
    })
    host.start()
  }

  private fun start(context: ReactContext) {
    HeadlessJsTaskContext.getInstance(context)
      .startTask(HeadlessJsTaskConfig(TASK, Arguments.createMap(), TIMEOUT_MS, true))
  }
}
