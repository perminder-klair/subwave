package com.getsubwave.androidauto

import android.content.Context
import android.net.Uri
import android.support.v4.media.MediaBrowserCompat.MediaItem
import android.support.v4.media.MediaDescriptionCompat
import org.json.JSONObject

/** One saved station, as JS mirrors it: the credential-free base is the id. */
internal data class CarStation(val id: String, val name: String) {
  fun toMediaItem(): MediaItem {
    val description = MediaDescriptionCompat.Builder()
      .setMediaId(id)
      .setTitle(name)
      .setSubtitle(Uri.parse(id).host ?: id)
      .build()
    return MediaItem(description, MediaItem.FLAG_PLAYABLE)
  }
}

/**
 * The saved stations, written by JS (StationContext, through the module's
 * setStations) for a car that may connect while JS is not running. The same
 * `{ active, stations: [{ id, name }] }` JSON the iOS module writes for Siri.
 * Names and bases only: a station's login and password stay in JS's keychain.
 */
internal object CarStations {
  private const val PREFS = "subwave.android-auto"
  private const val KEY = "stations"

  fun save(context: Context, json: String) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, json).apply()
  }

  fun load(context: Context): List<CarStation> {
    val json = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
      ?: return emptyList()
    return runCatching {
      val stations = JSONObject(json).getJSONArray("stations")
      (0 until stations.length()).map {
        val station = stations.getJSONObject(it)
        CarStation(station.getString("id"), station.getString("name"))
      }
    }.getOrDefault(emptyList())
  }
}
