// One value per text file. Liquidsoap reads them once at mixer startup, so a
// change needs a restart; update() rewrites them on every save. A few are read
// by docker/broadcast-entrypoint.sh instead, as marked.

import { writeFile } from 'node:fs/promises';
import { STATE_DIR } from '../config.js';
import { DEFAULTS } from './defaults.js';
// Pure policy module — no settings import of its own, so this stays acyclic.
import { mixerJingleRatioFile } from '../broadcast/jingle-rotate.js';

export const LIQ_JINGLE_RATIO_PATH = `${STATE_DIR}/liquidsoap_jingle_ratio.txt`;
export const LIQ_CROSSFADE_PATH = `${STATE_DIR}/liquidsoap_crossfade.txt`;
// radio.liq's `smooth_add` `p` on the heavy voice layer and the light intro one.
export const LIQ_DUCK_VOICE_PATH = `${STATE_DIR}/liquidsoap_duck_voice.txt`;
export const LIQ_DUCK_INTRO_PATH = `${STATE_DIR}/liquidsoap_duck_intro.txt`;
export const LIQ_ARCHIVE_ENABLED_PATH = `${STATE_DIR}/liquidsoap_archive_enabled.txt`;
export const LIQ_ARCHIVE_BITRATE_PATH = `${STATE_DIR}/liquidsoap_archive_bitrate.txt`;
export const LIQ_OPUS_ENABLED_PATH = `${STATE_DIR}/liquidsoap_opus_enabled.txt`;
const LIQ_OPUS_BITRATE_PATH = `${STATE_DIR}/liquidsoap_opus_bitrate.txt`;
const LIQ_FLAC_ENABLED_PATH = `${STATE_DIR}/liquidsoap_flac_enabled.txt`;
const LIQ_OGG_ICY_METADATA_PATH = `${STATE_DIR}/liquidsoap_ogg_icy_metadata.txt`;
const LIQ_AAC_ENABLED_PATH = `${STATE_DIR}/liquidsoap_aac_enabled.txt`;
const LIQ_AAC_BITRATE_PATH = `${STATE_DIR}/liquidsoap_aac_bitrate.txt`;
export const LIQ_STREAM_BITRATE_PATH = `${STATE_DIR}/liquidsoap_stream_bitrate.txt`;
// Entrypoint, not radio.liq: sizes Icecast's <burst-size> at broadcast boot.
export const LIQ_STREAM_BUFFER_SECONDS_PATH = `${STATE_DIR}/liquidsoap_stream_buffer_seconds.txt`;
// Entrypoint's too — Icecast <limits><clients>. The one file here that can
// LOSE: env ICECAST_MAX_CLIENTS wins, and the entrypoint logs which it took.
export const LIQ_ICECAST_MAX_CLIENTS_PATH = `${STATE_DIR}/liquidsoap_icecast_max_clients.txt`;
const LIQ_STATION_NAME_PATH = `${STATE_DIR}/liquidsoap_station_name.txt`;
// Entrypoint + AIO supervisor, not liquidsoap: only the literal 'true' renders
// the per-mount <authentication type="url"> blocks into icecast.xml.
export const ICECAST_LISTENER_AUTH_PATH = `${STATE_DIR}/icecast_listener_auth.txt`;
// Which MUSIC SOURCE the mixer builds: 'files' (dj_queue + auto.m3u request
// URIs — the default, and what an absent file means) or 'spotify' (a live PCM
// feed from librespot). settings.music.source, read once at mixer startup.
export const LIQ_MUSIC_MODE_PATH = `${STATE_DIR}/liquidsoap_music_mode.txt`;
// Read by docker/spotify/librespot-run.sh (not radio.liq): KEY=value lines
// for the receiver — its Spotify Connect device name and bitrate.
export const LIQ_SPOTIFY_PATH = `${STATE_DIR}/liquidsoap_spotify.txt`;

export const SPOTIFY_DEFAULT_DEVICE_NAME = 'SUB/WAVE';

export function musicModeFor(s: { music?: { source?: string } } | null | undefined): 'files' | 'spotify' {
  return s?.music?.source === 'spotify' ? 'spotify' : 'files';
}

export function spotifyHandoffFor(s: any): string {
  // One line per key; the wrapper splits on the first '='. Newlines and '='
  // in a device name would corrupt the file, so they are folded to spaces.
  // A CONSTANT default, deliberately not the station name: the receiver keeps
  // the name it booted with until the next mixer restart, while the controller
  // resolves the device by name live — so a station rename with the old
  // station-name default orphaned a running receiver ("receiver not found" on
  // every play; measured on the first real run). Operators rename it via
  // spotify.deviceName, which is a launch flag and flags the restart.
  const name = String(s?.spotify?.deviceName || SPOTIFY_DEFAULT_DEVICE_NAME).replace(/[\r\n=]+/g, ' ').replace(/\s+/g, ' ').trim();
  const bitrate = [96, 160, 320].includes(Number(s?.spotify?.bitrate)) ? Number(s.spotify.bitrate) : 320;
  return `device_name=${name}\nbitrate=${bitrate}\n`;
}

export async function writeLiquidsoapSettings(s) {
  // Not `s.jingleRatio` directly: with `jingleRotate: 'controller'` the mixer's
  // own rotate is switched off here (0 — #997's documented "jingles off"
  // value, so radio.liq needs no change) and the controller counts the tracks
  // instead. One resolver for both sides, so "the mixer is rotating" and "the
  // controller is rotating" cannot disagree. See broadcast/jingle-rotate.ts.
  await writeFile(LIQ_JINGLE_RATIO_PATH, mixerJingleRatioFile(s));
  await writeFile(LIQ_CROSSFADE_PATH, String(s.crossfadeDuration));
  // Defaulted like `station`: `undefined` in the handoff file unducks the DJ.
  await writeFile(LIQ_DUCK_VOICE_PATH, String(s.ducking?.voice ?? DEFAULTS.ducking.voice));
  await writeFile(LIQ_DUCK_INTRO_PATH, String(s.ducking?.intro ?? DEFAULTS.ducking.intro));
  await writeFile(LIQ_ARCHIVE_ENABLED_PATH, s.archive.enabled ? 'true' : 'false');
  await writeFile(LIQ_ARCHIVE_BITRATE_PATH, String(s.archive.bitrate));
  await writeFile(LIQ_OPUS_ENABLED_PATH, s.stream.opusEnabled ? 'true' : 'false');
  await writeFile(LIQ_OPUS_BITRATE_PATH, String(s.stream.opusBitrate));
  await writeFile(LIQ_FLAC_ENABLED_PATH, s.stream.flacEnabled ? 'true' : 'false');
  await writeFile(LIQ_OGG_ICY_METADATA_PATH, s.stream.oggIcyMetadata ? 'true' : 'false');
  await writeFile(LIQ_AAC_ENABLED_PATH, s.stream.aacEnabled ? 'true' : 'false');
  await writeFile(LIQ_AAC_BITRATE_PATH, String(s.stream.aacBitrate));
  await writeFile(LIQ_STREAM_BITRATE_PATH, String(s.stream.bitrate));
  await writeFile(LIQ_STREAM_BUFFER_SECONDS_PATH, String(s.stream.bufferSeconds));
  await writeFile(LIQ_ICECAST_MAX_CLIENTS_PATH, String(s.stream.maxListeners));
  await writeFile(LIQ_STATION_NAME_PATH, s.station || DEFAULTS.station);
  await writeFile(
    ICECAST_LISTENER_AUTH_PATH,
    s.privacy?.listenerAuth ? 'true' : 'false',
  );
  await writeFile(LIQ_MUSIC_MODE_PATH, musicModeFor(s));
  await writeFile(LIQ_SPOTIFY_PATH, spotifyHandoffFor(s));
}

