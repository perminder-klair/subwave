package com.getsubwave.androidauto

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// The JS half is modules/android-auto/index.ts; the car's side is
// SubwaveBrowseService.
class SubwaveAndroidAutoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SubwaveAndroidAuto")

    /** The saved stations and the active one, as JSON from JS:
     *  `{ active, stations: [{ id, name }] }`. Redraws the car's list. */
    Function("setStations") { json: String ->
      val context = appContext.reactContext ?: return@Function
      CarStations.save(context, json)
      SubwaveBrowseService.stationsChanged()
    }
  }
}
