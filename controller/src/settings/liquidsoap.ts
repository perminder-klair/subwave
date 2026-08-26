// Liquidsoap reads tiny text files instead of JSON — one value per file, read
// once at mixer startup. settings.update() writes them on every save; the
// broadcast entrypoint reads a couple of them too (see the per-path comments).
//
// Part of the settings/ split — see ../settings.ts for the public barrel.

import { writeFile } from 'node:fs/promises';
import { STATE_DIR } from '../config.js';
import { DEFAULTS } from './defaults.js';

export const LIQ_JINGLE_RATIO_PATH = `${STATE_DIR}/liquidsoap_jingle_ratio.txt`;
export const LIQ_CROSSFADE_PATH = `${STATE_DIR}/liquidsoap_crossfade.txt`;
export const LIQ_ARCHIVE_ENABLED_PATH = `${STATE_DIR}/liquidsoap_archive_enabled.txt`;
export const LIQ_ARCHIVE_BITRATE_PATH = `${STATE_DIR}/liquidsoap_archive_bitrate.txt`;
export const LIQ_OPUS_ENABLED_PATH = `${STATE_DIR}/liquidsoap_opus_enabled.txt`;
const LIQ_OPUS_BITRATE_PATH = `${STATE_DIR}/liquidsoap_opus_bitrate.txt`;
const LIQ_FLAC_ENABLED_PATH = `${STATE_DIR}/liquidsoap_flac_enabled.txt`;
const LIQ_OGG_ICY_METADATA_PATH = `${STATE_DIR}/liquidsoap_ogg_icy_metadata.txt`;
const LIQ_AAC_ENABLED_PATH = `${STATE_DIR}/liquidsoap_aac_enabled.txt`;
const LIQ_AAC_BITRATE_PATH = `${STATE_DIR}/liquidsoap_aac_bitrate.txt`;
export const LIQ_STREAM_BITRATE_PATH = `${STATE_DIR}/liquidsoap_stream_bitrate.txt`;
// Read by docker/broadcast-entrypoint.sh (not radio.liq) to size Icecast's
// <burst-size>. Same liquidsoap_*.txt convention because it shares their
// lifecycle exactly: written on save, consumed once at broadcast boot.
export const LIQ_STREAM_BUFFER_SECONDS_PATH = `${STATE_DIR}/liquidsoap_stream_buffer_seconds.txt`;
// Also the ENTRYPOINT's, not radio.liq's — Icecast's <limits><clients>. Unlike
// every other file here it is an override that can LOSE: ICECAST_MAX_CLIENTS in
// the environment wins, because the var shipped first and is wired into all
// three compose files. The entrypoint logs which source it took so an operator
// editing the admin field on a station whose .env pins the var can see why
// nothing moved.
export const LIQ_ICECAST_MAX_CLIENTS_PATH = `${STATE_DIR}/liquidsoap_icecast_max_clients.txt`;
const LIQ_STATION_NAME_PATH = `${STATE_DIR}/liquidsoap_station_name.txt`;
// Read by the BROADCAST ENTRYPOINT (docker/broadcast-entrypoint.sh + the AIO
// supervisor), not liquidsoap: only the literal value 'true' makes the
// entrypoint render the per-mount <authentication type="url"> blocks into
// icecast.xml on the next broadcast restart.
export const ICECAST_LISTENER_AUTH_PATH = `${STATE_DIR}/icecast_listener_auth.txt`;

export async function writeLiquidsoapSettings(s) {
  await writeFile(LIQ_JINGLE_RATIO_PATH, String(s.jingleRatio));
  await writeFile(LIQ_CROSSFADE_PATH, String(s.crossfadeDuration));
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
}

