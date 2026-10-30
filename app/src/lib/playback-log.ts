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
// - an `auth=` outside a URL, the value of an Authorization or
//   Proxy-Authorization header, and a Basic or Bearer credential with no header
//   name, become [redacted], and so does the rest of a line after an
//   x-station-auth header's name (only GET /lyrics/current sends one);
// - an iOS route change's outputs keep each port's type, from a list of Apple's
//   own, and drop its name, which is often the owner's ("Sam's AirPods").
// The rules match patterns rather than trusting the call sites, because a
// playback error's text isn't the app's own. Android's is ExoPlayer's fixed
// wording and RNTP's code, neither of which quotes a URL, but iOS's is the
// localizedDescription of whatever AVPlayer failed on, and nothing promises
// what that says.

export const PLAYBACK_LOG_LIMIT = 300;

// Past this a line is cut, after redaction, so a cut can't split a secret
// from the pattern that would have caught it.
export const PLAYBACK_LINE_MAX = 500;

const REDACTED = '[redacted]';

// ://[userinfo@]host[:port][path][?query][#fragment]. Both rules start at the
// :// and leave the scheme where it is: looking for a scheme means scanning to
// the end of the line from every . + and - in it, which took 3.8 s on a 100 KB
// `a.a.a…`. They're two rules because a path can hold another URL, whose
// userinfo a single rule would take for path and keep. A slash may be
// backslashed: Apple's JSONSerialization writes https:\/\/ by default.
// The app encodes every secret it puts in a URL (credentialedBase,
// withStreamAuth), so a raw / ? # or @ can't sit inside userinfo or the query.
// encodeURIComponent leaves ' ( ) ! * ~ as they are, so neither the query nor
// an auth= value below may stop at one: a station password "it's" would leave
// "'s" behind.
const URL_USERINFO_RE = /(:\\*\/\\*\/)[^\s/?#]*@/g;
const URL_QUERY_RE = /(:\\*\/\\*\/[^\s?#"'<>]*)(?:[?#][^\s"<>]*)?/g;
// The separator takes in what wraps a value, so the value that follows is still
// the secret: a Java map's [ ], Swift's Optional( ) and Java's Optional[ ], and
// the backslashed quotes of JSON inside a JSON string. A scheme is found behind
// any other wrapper too (<Basic …>, Some(Basic …)): taken for the value, it
// would leave the credential after it with no word to be found by.
const HEADER_RE =
  /\b((?:proxy-)?authorization)(\\*["']?\s*[:=](?:\s*(?:optional)?[\\"'[(]+)*\s*)(?:[^\s"',;)}\]]*?\b(basic|bearer|digest)\s+)?[^\s"',;)}\]]*/gi;
// x-station-auth carries the password itself, unencoded, and a password has no
// character it can't contain: "it's" or "a, b" would leave the rest behind. So
// nothing after the name is kept.
const STATION_AUTH_RE = /\b(x-station-auth\\*["']?\s*[:=]\s*)[\s\S]*$/i;
// A credential with no header name to find it by, which only its shape gives
// away. That shape is also a sentence's, so it costs some readability and a
// little coverage: CREDENTIAL_MIN keeps "Basic realm" and "bearer token" but
// leaves a shorter credential (a 3-byte login, `a:b`, is 4 characters), and
// CREDENTIAL_PROSE keeps the few words a line about auth would use, whole and
// exact, so a token built on one still goes. Any other long word after "basic"
// or "bearer" is lost: "basic connectivity" reads "basic [redacted]".
const CREDENTIAL_RE = /\b(basic|bearer)\s+([A-Za-z0-9+/._~-]+={0,2})/gi;
const CREDENTIAL_MIN = 8; // characters, padding included
const CREDENTIAL_PROSE = /^(?:authentication|authorization|credentials)\.?$/i;
// Not after a hyphen: x-station-auth is the header rule's.
const AUTH_PARAM_RE = /(^|[^\w-])auth=[^\s&#"<>,;}\]]*/gi;
// [\s\S], since a device name can hold a line terminator, which `.` stops at.
const ROUTE_OUTPUTS_RE = /\boutputs=([\s\S]*)$/;

/** `msg` with every secret the rules above know of removed. The header rules go
 *  first: a query runs to the next space, so it could take a header's name and
 *  leave its value with nothing to find it by. */
export function redactPlaybackLine(msg: string): string {
  return msg
    .replace(STATION_AUTH_RE, `$1${REDACTED}`)
    .replace(HEADER_RE, (_m, name: string, sep: string, scheme?: string) =>
      `${name}${sep}${scheme ? `${scheme} ` : ''}${REDACTED}`,
    )
    .replace(CREDENTIAL_RE, (m, scheme: string, token: string) =>
      token.length < CREDENTIAL_MIN || CREDENTIAL_PROSE.test(token) ? m : `${scheme} ${REDACTED}`,
    )
    .replace(URL_USERINFO_RE, '$1')
    .replace(URL_QUERY_RE, '$1')
    .replace(AUTH_PARAM_RE, (_m, before: string) => `${before}auth=${REDACTED}`)
    .replace(ROUTE_OUTPUTS_RE, (_m, outputs: string) => `outputs=${portTypes(outputs)}`);
}

// Every AVAudioSession.Port raw value in the iOS 27.1 SDK. AVFAudio's
// AVAudioSessionTypes.h names the 22 ports but not their strings, so a new
// SDK's port goes here by hand, and reads as OTHER_PORT until it does. The
// inputs can't be in a route's outputs. One of them, the Continuity microphone,
// is listed under both spellings in use, since Apple doesn't publish its string.
const PORT_TYPES = new Set([
  'ContinuityMicrophone',
  'MicrophoneContinuity',
  'LineIn',
  'MicrophoneBuiltIn',
  'MicrophoneWired',
  'LineOut',
  'Headphones',
  'BluetoothA2DPOutput',
  'Receiver',
  'Speaker',
  'HDMIOutput',
  'AirPlay',
  'BluetoothLE',
  'MediaDeviceExtension',
  'BluetoothHFP',
  'USBAudio',
  'CarAudio',
  'Virtual',
  'PCI',
  'FireWire',
  'DisplayPort',
  'AVB',
  'Thunderbolt',
]);
const OTHER_PORT = 'Other';

// "AirPlay:Kitchen,Speaker:iPhone Speaker" → "AirPlay,Speaker". The native
// module joins `type:name` on commas, and a name can hold anything, so
// "BluetoothA2DPOutput:Sam,Dave:x" can't be told from two outputs. Only a word
// from PORT_TYPES is ever written. Any other word before a colon reads as
// OTHER_PORT rather than going: it may be a port Apple has added, and a route
// that lost it would read as having no output. A name in that shape counts as
// one output too many and leaks nothing. A piece with no such word is the rest
// of a name, and is dropped.
function portTypes(outputs: string): string {
  return outputs
    .split(',')
    .map((o) => /^([A-Za-z0-9]+):/.exec(o)?.[1])
    .filter((t): t is string => !!t)
    .map((t) => (PORT_TYPES.has(t) ? t : OTHER_PORT))
    .join(',');
}

// What the event line reads off a track-player event. A PlaybackError isn't the
// shape RNTP types: Android sends `code` and `message`, each only when it has
// one, and iOS sends `error`, a localizedDescription or null. The `error` on a
// PlaybackState in state=error is a { code, message } object, and stays out.
export interface PlaybackEventFields {
  type: string;
  state?: unknown;
  code?: unknown;
  message?: unknown;
  error?: unknown;
}

/** The line for a track-player event, with its error's code and text. The text
 *  comes last, so the cut can't take the code. */
export function playbackEventLine(event: PlaybackEventFields): string {
  const text = [event.message, event.error].find((t): t is string => typeof t === 'string');
  return [
    `event ${event.type}`,
    ...('state' in event ? [`state=${String(event.state)}`] : []),
    ...(typeof event.code === 'string' ? [`code=${event.code}`] : []),
    ...(text !== undefined ? [`msg=${text}`] : []),
  ].join(' ');
}

export class PlaybackLog {
  private readonly limit: number;
  private readonly now: () => number;
  private entries: string[] = [];

  constructor(limit = PLAYBACK_LOG_LIMIT, now: () => number = Date.now) {
    this.limit = limit;
    this.now = now;
  }

  /** Stamp, redact and keep `msg`, dropping the oldest line past the limit.
   *  Never throws: plog runs mid-reload and ahead of each event's dispatch, so a
   *  throw here would wedge the recovery (#2160). Hermes can throw from a regex
   *  past its limits, and a line that can't be redacted is lost, never kept raw. */
  add(msg: string): void {
    try {
      const clean = redactPlaybackLine(msg);
      const cut = clean.length > PLAYBACK_LINE_MAX ? `${clean.slice(0, PLAYBACK_LINE_MAX)}…` : clean;
      this.entries.push(`${new Date(this.now()).toISOString()} ${cut}`);
      if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    } catch {
      // The line is lost, as above.
    }
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
