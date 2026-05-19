// Connection config for the terminal player. Resolution order, highest first:
//   1. CLI flags (--api / --stream)
//   2. environment (SUBWAVE_API_URL / SUBWAVE_STREAM_URL)
//   3. the dev-stack defaults (controller on :7701, Icecast on :7702)
const DEFAULT_API = 'http://localhost:7701';
const DEFAULT_STREAM = 'http://localhost:7702/stream.mp3';

export function resolveConfig(flags = {}) {
  const apiUrl = (flags.api || process.env.SUBWAVE_API_URL || DEFAULT_API)
    .replace(/\/+$/, '');
  const streamUrl = flags.stream || process.env.SUBWAVE_STREAM_URL || DEFAULT_STREAM;
  return { apiUrl, streamUrl };
}
