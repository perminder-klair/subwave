import {
  ALEXA_INTENT_POLICY_CAPABILITIES,
  ALEXA_INTENT_POLICY_DEFAULT_ALLOWED,
  type AlexaIntentPolicyCapabilityId,
} from '../schemas/settings.js';

/**
 * Listener-facing Alexa access policy.
 *
 * The allowlist contains configurable capabilities only. Required Alexa
 * behaviours are deliberately not represented here and are always available
 * so a listener can exit playback and complete the skill's dialog protocol.
 */
export interface AlexaIntentPolicy {
  version: 1;
  mode: 'allowlist';
  allowed: AlexaIntentPolicyCapabilityId[];
}

export type AlexaCapabilityId = AlexaIntentPolicyCapabilityId
  | 'playback.pause'
  | 'playback.stop'
  | 'system.help'
  | 'system.dialog';

export type AlexaIntentGroupId =
  | 'playback'
  | 'station-information'
  | 'song-requests'
  | 'request-management'
  | 'required';

export interface AlexaIntentCapability {
  id: AlexaCapabilityId;
  group: AlexaIntentGroupId;
  label: string;
  description: string;
  intentNames: readonly string[];
  configurable: boolean;
  required?: boolean;
}

export interface AlexaIntentGroup {
  id: AlexaIntentGroupId;
  label: string;
  description: string;
  capabilities: readonly AlexaIntentCapability[];
}

const REQUIRED_CAPABILITIES = new Set<AlexaCapabilityId>([
  'playback.pause',
  'playback.stop',
  'system.help',
  'system.dialog',
]);

const CAPABILITIES: readonly AlexaIntentCapability[] = [
  {
    id: 'playback.start',
    group: 'playback',
    label: 'Start or resume playback',
    description: 'Open the skill, start the station, or resume live playback.',
    intentNames: ['LaunchRequest', 'StartRadioIntent', 'PlayRadioIntent', 'AMAZON.ResumeIntent'],
    configurable: true,
  },
  {
    id: 'request.status',
    group: 'station-information',
    label: 'Request status',
    description: 'Tell the listener what happened to their latest request.',
    intentNames: ['RequestStatusIntent'],
    configurable: true,
  },
  {
    id: 'track.now',
    group: 'station-information',
    label: 'Now playing',
    description: 'Report the track currently on air.',
    intentNames: ['NowPlayingIntent', 'WhatIsPlayingIntent', 'CurrentSongIntent'],
    configurable: true,
  },
  {
    id: 'track.previous',
    group: 'station-information',
    label: 'Previous track',
    description: 'Report the most recently played track.',
    intentNames: ['PreviousTrackIntent'],
    configurable: true,
  },
  {
    id: 'track.upcoming',
    group: 'station-information',
    label: 'Upcoming track',
    description: 'Report what is scheduled to play next.',
    intentNames: ['UpcomingIntent', 'NextSongIntent', 'WhatIsNextIntent'],
    configurable: true,
  },
  {
    id: 'queue.preview',
    group: 'station-information',
    label: 'Queue preview',
    description: 'Read a short preview of the next few tracks.',
    intentNames: ['QueuePreviewIntent'],
    configurable: true,
  },
  {
    id: 'station.status',
    group: 'station-information',
    label: 'Station status',
    description: 'Tell the listener whether the station is on air.',
    intentNames: ['StationStatusIntent'],
    configurable: true,
  },
  {
    id: 'track.recent',
    group: 'station-information',
    label: 'Recently played',
    description: 'List tracks that played recently.',
    intentNames: ['RecentTracksIntent'],
    configurable: true,
  },
  {
    id: 'track.details',
    group: 'station-information',
    label: 'Track details',
    description: 'Read album, artist, year, genre, or language metadata.',
    intentNames: ['TrackDetailsIntent'],
    configurable: true,
  },
  {
    id: 'show.current',
    group: 'station-information',
    label: 'Current show and DJ',
    description: 'Report the active show and presenter.',
    intentNames: ['CurrentShowIntent'],
    configurable: true,
  },
  {
    id: 'request.song',
    group: 'song-requests',
    label: 'Request a song',
    description: 'Submit a song request through the shared listener pipeline.',
    intentNames: ['RequestSongIntent'],
    configurable: true,
  },
  {
    id: 'request.similar',
    group: 'song-requests',
    label: 'More like this',
    description: 'Request a similar track based on what is playing.',
    intentNames: ['MoreLikeThisIntent'],
    configurable: true,
  },
  {
    id: 'request.same-artist',
    group: 'song-requests',
    label: 'Another by this artist',
    description: 'Request another track by the current artist.',
    intentNames: ['AnotherByArtistIntent'],
    configurable: true,
  },
  {
    id: 'request.dedication',
    group: 'song-requests',
    label: 'Dedications',
    description: 'Send a song dedication to another person or group.',
    intentNames: ['DedicationIntent'],
    configurable: true,
  },
  {
    id: 'request.replace',
    group: 'request-management',
    label: 'Replace a request',
    description: 'Replace the listener’s latest waiting request.',
    intentNames: ['ReplaceRequestIntent'],
    configurable: true,
  },
  {
    id: 'request.cancel',
    group: 'request-management',
    label: 'Cancel a request',
    description: 'Cancel the listener’s latest waiting request.',
    intentNames: ['CancelRequestIntent', 'AMAZON.CancelIntent'],
    configurable: true,
  },
  {
    id: 'request.reminder',
    group: 'request-management',
    label: 'Request reminders',
    description: 'Create a reminder for the listener’s requested song.',
    intentNames: ['RequestReminderIntent', 'Connections.Response (AskFor)'],
    configurable: true,
  },
  {
    id: 'playback.pause',
    group: 'required',
    label: 'Pause playback',
    description: 'Always available so a listener can stop hearing the stream.',
    intentNames: ['AMAZON.PauseIntent'],
    configurable: false,
    required: true,
  },
  {
    id: 'playback.stop',
    group: 'required',
    label: 'Stop playback safely',
    description: 'Always available so a listener can leave playback.',
    intentNames: ['AMAZON.StopIntent', 'AMAZON.NavigateHomeIntent'],
    configurable: false,
    required: true,
  },
  {
    id: 'system.help',
    group: 'required',
    label: 'Help and fallback',
    description: 'Always available to explain what the skill can do.',
    intentNames: ['AMAZON.HelpIntent', 'AMAZON.FallbackIntent'],
    configurable: false,
    required: true,
  },
  {
    id: 'system.dialog',
    group: 'required',
    label: 'Dialog confirmations',
    description: 'Always available for yes/no confirmations and slot dialogs.',
    intentNames: ['AMAZON.YesIntent', 'AMAZON.NoIntent'],
    configurable: false,
    required: true,
  },
];

const GROUPS: readonly AlexaIntentGroup[] = [
  {
    id: 'playback',
    label: 'Playback',
    description: 'Control whether listeners can start or resume playback.',
    capabilities: CAPABILITIES.filter(capability => capability.group === 'playback' && capability.configurable),
  },
  {
    id: 'station-information',
    label: 'Station information',
    description: 'Read-only information about the station, tracks, queue, and show.',
    capabilities: CAPABILITIES.filter(capability => capability.group === 'station-information'),
  },
  {
    id: 'song-requests',
    label: 'Song requests',
    description: 'Actions that submit a new song-related request.',
    capabilities: CAPABILITIES.filter(capability => capability.group === 'song-requests'),
  },
  {
    id: 'request-management',
    label: 'Request management',
    description: 'Actions that change, cancel, or remind about an existing request.',
    capabilities: CAPABILITIES.filter(capability => capability.group === 'request-management'),
  },
  {
    id: 'required',
    label: 'Required Alexa behavior',
    description: 'Safety and dialog behavior that stays enabled and cannot be disabled.',
    capabilities: CAPABILITIES.filter(capability => capability.group === 'required'),
  },
];

const KNOWN_CONFIGURABLE = new Set<string>(ALEXA_INTENT_POLICY_CAPABILITIES);

export function defaultAlexaIntentPolicy(): AlexaIntentPolicy {
  return {
    version: 1,
    mode: 'allowlist',
    allowed: [...ALEXA_INTENT_POLICY_DEFAULT_ALLOWED],
  };
}

export function normalizeAlexaIntentPolicy(raw: unknown): AlexaIntentPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultAlexaIntentPolicy();
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || value.mode !== 'allowlist' || !Array.isArray(value.allowed)) {
    return defaultAlexaIntentPolicy();
  }
  const allowed = [...new Set(value.allowed.filter((id): id is AlexaIntentPolicyCapabilityId =>
    typeof id === 'string' && KNOWN_CONFIGURABLE.has(id)))];
  return { version: 1, mode: 'allowlist', allowed };
}

export function alexaIntentGroups(): readonly AlexaIntentGroup[] {
  return GROUPS;
}

export function alexaIntentCapabilities(): readonly AlexaIntentCapability[] {
  return CAPABILITIES;
}

export function isAlexaCapabilityAllowed(policy: AlexaIntentPolicy, capability: AlexaCapabilityId): boolean {
  if (REQUIRED_CAPABILITIES.has(capability)) return true;
  return policy.allowed.includes(capability as AlexaIntentPolicyCapabilityId);
}

export function decideAlexaCapability(policy: AlexaIntentPolicy, capability: AlexaCapabilityId): {
  allowed: boolean;
  capability: AlexaCapabilityId;
  group: AlexaIntentGroupId;
  required: boolean;
} {
  const catalog = CAPABILITIES.find(item => item.id === capability);
  const required = REQUIRED_CAPABILITIES.has(capability);
  return {
    allowed: isAlexaCapabilityAllowed(policy, capability),
    capability,
    group: catalog?.group || 'required',
    required,
  };
}
