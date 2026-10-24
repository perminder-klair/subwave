import {
  ALEXA_STREAM_MOUNTS,
  type AlexaStreamMount,
} from '../schemas/settings.js';

type StreamSettings = {
  opusEnabled?: boolean;
  flacEnabled?: boolean;
  aacEnabled?: boolean;
};

export interface AlexaStreamOption {
  mount: AlexaStreamMount;
  label: string;
  description: string;
  enabled: boolean;
}

const STREAM_DETAILS: Record<AlexaStreamMount, Omit<AlexaStreamOption, 'mount' | 'enabled'>> = {
  '/stream.mp3': {
    label: 'MP3',
    description: 'MP3 stream; the most compatible option for Alexa and other players.',
  },
  '/stream.opus': {
    label: 'Opus',
    description: 'Ogg-Opus stream; enable the Opus mount before selecting it.',
  },
  '/stream.flac': {
    label: 'FLAC',
    description: 'Ogg FLAC lossless stream; enable the FLAC mount before selecting it.',
  },
  '/stream.aac': {
    label: 'AAC',
    description: 'AAC-LC ADTS stream; enable the AAC mount before selecting it.',
  },
};

export function normalizeAlexaStreamMount(value: unknown): AlexaStreamMount {
  return ALEXA_STREAM_MOUNTS.includes(value as AlexaStreamMount)
    ? value as AlexaStreamMount
    : '/stream.mp3';
}

export function isAlexaStreamMountEnabled(
  mount: AlexaStreamMount,
  stream: StreamSettings | undefined,
): boolean {
  if (mount === '/stream.mp3') return true;
  if (mount === '/stream.opus') return stream?.opusEnabled === true;
  if (mount === '/stream.flac') return stream?.flacEnabled === true;
  return stream?.aacEnabled === true;
}

export function effectiveAlexaStreamMount(
  value: unknown,
  stream: StreamSettings | undefined,
): AlexaStreamMount {
  const mount = normalizeAlexaStreamMount(value);
  return isAlexaStreamMountEnabled(mount, stream) ? mount : '/stream.mp3';
}

export function alexaStreamUrl(siteUrl: string, mount: unknown): string {
  const origin = siteUrl.trim().replace(/\/+$/, '');
  return origin ? `${origin}${normalizeAlexaStreamMount(mount)}` : '';
}

export function alexaStreamOptions(
  stream: StreamSettings | undefined,
): AlexaStreamOption[] {
  return ALEXA_STREAM_MOUNTS.map(mount => ({
    mount,
    ...STREAM_DETAILS[mount],
    enabled: isAlexaStreamMountEnabled(mount, stream),
  }));
}
