// The playback log a listener can send us (#2140). usePlayer's plog writes
// every line here, Release builds included, so the decisions stream-recovery
// names (a hold, a reload and why) reach a bug report instead of only a dev
// console. It lives in memory, holds the last PLAYBACK_LOG_LIMIT lines, and
// leaves the phone only when the listener shares it from the About sheet.
//
// A line is redacted before it is stored, never on the way out, so no secret
// sits in memory for a later share to leak:
// - a URL keeps its scheme, host and path. Its userinfo (a Station login,
//   #1873) goes, and so do its query, where the station password rides as
//   ?auth= (#478), and its fragment;
// - an `auth=` outside a URL, and the value of an Authorization,
//   Proxy-Authorization or x-station-auth header, become [redacted];
// - an iOS route change's outputs keep each port's type and drop its name,
//   which is often the owner's ("Sam's AirPods").
// The rules match patterns rather than trusting the call sites, because one
// line's text isn't the app's own: a PlaybackError's message comes from the
// native player, and can quote the stream URL it failed on.

export const PLAYBACK_LOG_LIMIT = 300;

// Past this a line is cut, after redaction, so a cut can't split a secret
// from the pattern that would have caught it.
export const PLAYBACK_LINE_MAX = 500;

const REDACTED = '[redacted]';

// scheme://[userinfo@]host[:port][path][?query][#fragment]. The app encodes
// every secret it puts in a URL (credentialedBase, withStreamAuth), so a raw
// / ? # or @ can't sit inside userinfo or the query. encodeURIComponent leaves
// ' ( ) ! * ~ as they are, so neither the query nor an auth= value below may
// stop at one: a station password "it's" would leave "'s" behind.
const URL_RE = /\b([a-z][a-z0-9+.-]*):\/\/(?:[^\s/?#]*@)?([^\s/?#"'<>]*)([^\s?#"'<>]*)(?:[?#][^\s"<>]*)?/gi;
const HEADER_RE =
  /\b((?:proxy-)?authorization|x-station-auth)(["']?\s*[:=]\s*["']?)(?:(basic|bearer|digest)\s+)?[^\s"',;)}\]]*/gi;
// Not after a hyphen: x-station-auth is the header rule's.
const AUTH_PARAM_RE = /(^|[^\w-])auth=[^\s&#"<>,;}\]]*/gi;
const ROUTE_OUTPUTS_RE = /\boutputs=(.*)$/;

/** `msg` with every secret the rules above know of removed. */
export function redactPlaybackLine(msg: string): string {
  return msg
    .replace(URL_RE, (_m, scheme: string, host: string, path: string) => `${scheme}://${host}${path}`)
    .replace(HEADER_RE, (_m, name: string, sep: string, scheme?: string) =>
      `${name}${sep}${scheme ? `${scheme} ` : ''}${REDACTED}`,
    )
    .replace(AUTH_PARAM_RE, (_m, before: string) => `${before}auth=${REDACTED}`)
    .replace(ROUTE_OUTPUTS_RE, (_m, outputs: string) => `outputs=${portTypes(outputs)}`);
}

// "AirPlay:Kitchen,Speaker:iPhone Speaker" → "AirPlay,Speaker". A port type is
// one AVAudioSession.Port word; a name with a comma in it leaves a piece with
// no type, which is dropped rather than kept.
function portTypes(outputs: string): string {
  return outputs
    .split(',')
    .map((o) => /^\s*([A-Za-z0-9]+):/.exec(o)?.[1])
    .filter((t): t is string => !!t)
    .join(',');
}

export class PlaybackLog {
  private readonly limit: number;
  private readonly now: () => number;
  private entries: string[] = [];

  constructor(limit = PLAYBACK_LOG_LIMIT, now: () => number = Date.now) {
    this.limit = limit;
    this.now = now;
  }

  /** Stamp, redact and keep `msg`, dropping the oldest line past the limit. */
  add(msg: string): void {
    const clean = redactPlaybackLine(msg);
    const cut = clean.length > PLAYBACK_LINE_MAX ? `${clean.slice(0, PLAYBACK_LINE_MAX)}…` : clean;
    this.entries.push(`${new Date(this.now()).toISOString()} ${cut}`);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }

  /** The kept lines, oldest first. */
  lines(): string[] {
    return [...this.entries];
  }
}

/** The app's one log, written by usePlayer's plog. */
export const playbackLog = new PlaybackLog();

export interface PlaybackLogSource {
  /** The app version, e.g. "1.6.1". */
  version: string;
  /** The JS bundle running, e.g. "OTA 1a2b3c4d, production"; null when unknown. */
  bundle: string | null;
  /** "iOS" or "Android". */
  platform: string;
  /** e.g. "18.2", or "15 (API 35)". */
  osVersion: string;
}

/** The text the About sheet shares: what is running, then the lines. */
export function playbackLogReport(source: PlaybackLogSource, lines: readonly string[]): string {
  const bundle = source.bundle ? ` (${source.bundle})` : '';
  return [
    `SUB/WAVE app ${source.version}${bundle} · ${source.platform} ${source.osVersion}`,
    `Playback log: ${lines.length} line${lines.length === 1 ? '' : 's'}, oldest first, times in UTC.`,
    '',
    ...lines,
  ].join('\n');
}
