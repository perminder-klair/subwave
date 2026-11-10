import { absoluteUrl, canonicalUrl, type PageScope } from '@/lib/seo';

// The /llms.txt index (https://llmstxt.org): what SUB/WAVE is, stated as the
// few facts a model most often gets wrong, then the pages worth reading.
//
// Links resolve the way the sitemap's do. A shared page (setup, manual,
// community catalogs) goes through canonicalUrl(), so a non-official install
// points it at getsubwave.com, which is where those pages are indexed. The
// station's own player, stream and API resolve on this install's origin.

export const REPO_RAW_URL = 'https://raw.githubusercontent.com/perminder-klair/subwave/main';

export type LlmsHref =
  /** A page under web/app. `scope` must match the scope in the page's own pageMeta. */
  | { page: string; scope?: PageScope }
  /** A path this install serves from the controller or Icecast, not from Next. */
  | { endpoint: string }
  /** A Markdown file in the repo, linked raw so a model reads the source. */
  | { repo: string };

export interface LlmsLink {
  title: string;
  href: LlmsHref;
  note?: string;
}

export interface LlmsSection {
  title: string;
  links: LlmsLink[];
}

const SUMMARY =
  'SUB/WAVE is open-source (MIT), self-hosted software for running a personal internet radio station. One Icecast stream carries one broadcast that every listener hears at the same time, and an AI DJ picks tracks from the operator\'s own music library and talks between them.';

const FACTS = [
  'It is radio, not a playlist. There is no per-listener queue and listeners cannot skip; a track ending is the only transition. Listeners can ask for music in plain language, and the DJ fits the request into the broadcast.',
  'The music is the operator\'s own library, served by Navidrome over the Subsonic API. SUB/WAVE does not generate music and ships no catalogue.',
  'The DJ is a language model the operator chooses (Ollama, Anthropic, OpenAI, Google, DeepSeek, OpenRouter, Requesty, Vercel AI Gateway, or any OpenAI-compatible server) and can switch without a redeploy. Its voice is text-to-speech: Piper and Kokoro built in, Chatterbox and PocketTTS in an optional sidecar, cloud voices, or a self-hosted TTS server.',
  'A station runs with Docker Compose on one host. The quickest install is `curl -fsSL https://cli.getsubwave.com | sh`, then `subwave setup` to connect Navidrome and a language model.',
  'Every station serves the same routes on one origin: the player at `/listen`, the admin console at `/admin`, the HTTP API under `/api`, an MCP server at `/api/mcp`, and the broadcast at `/stream.mp3` (always on) with optional `/stream.opus`, `/stream.aac` and `/stream.flac` mounts.',
  'Two optional paid services fund the project: DJ Brain, a hosted model (with an optional cloud voice) for a self-hosted station, and SUB/WAVE Hosted, a whole station at `yourname.getsubwave.com`. Both are at https://my.getsubwave.com/.',
];

export const LLMS_SECTIONS: LlmsSection[] = [
  {
    title: 'This station',
    links: [
      { title: 'Player', href: { page: '/listen', scope: 'station' }, note: 'the live broadcast in a browser, with what is on air and song requests' },
      { title: 'MP3 stream', href: { endpoint: '/stream.mp3' }, note: 'the broadcast itself, playable by anything that speaks Icecast MP3' },
      { title: 'Now playing', href: { endpoint: '/api/now-playing' }, note: 'JSON for the current track and the show on air; public, no credential' },
      { title: 'Schedule', href: { endpoint: '/api/schedule' }, note: 'JSON for the shows, the weekly grid and the DJ roster; public, no credential' },
    ],
  },
  {
    title: 'Setup',
    links: [
      { title: 'Setup overview', href: { page: '/setup' }, note: 'connect a Navidrome library and an LLM provider and go on air' },
      { title: 'Prerequisites', href: { page: '/setup/prerequisites' }, note: 'Navidrome, Docker, and a language model such as Ollama' },
      { title: 'Quick start', href: { page: '/setup/quick-start' }, note: 'the one-line installer and the `subwave` CLI' },
      { title: 'Linux', href: { page: '/setup/linux' } },
      { title: 'macOS', href: { page: '/setup/macos' } },
      { title: 'Windows', href: { page: '/setup/windows' }, note: 'WSL2 with the CLI, or docker compose from PowerShell' },
      { title: 'Unraid', href: { page: '/setup/unraid' } },
      { title: 'Manual install', href: { page: '/setup/manual' }, note: 'plain Docker Compose with your own reverse proxy' },
      { title: 'Updates and help', href: { page: '/setup/updates' } },
    ],
  },
  {
    title: 'Manual',
    links: [
      { title: 'Getting started', href: { page: '/manual/getting-started' }, note: 'what the station is and how to tune in' },
      { title: 'Making requests', href: { page: '/manual/requests' }, note: 'what the DJ can match and how a request reaches the air' },
      { title: 'How the DJ works', href: { page: '/manual/dj' }, note: 'how it picks the next track and writes its spoken links' },
      { title: 'Concepts', href: { page: '/manual/concepts' }, note: 'persona dials, the two track pickers, playlists versus shows, dayparts' },
      { title: 'Admin console', href: { page: '/manual/admin' }, note: 'settings, personas, shows, the library and everything an operator can tune' },
      { title: 'Models and tokens', href: { page: '/manual/llm' }, note: 'choosing an LLM, running on local hardware, keeping token costs down' },
      { title: 'Voices and TTS', href: { page: '/manual/voices' }, note: 'the speech engines, voice cloning, and GPU options' },
      { title: 'Agent access', href: { page: '/manual/mcp' }, note: 'control a station from Claude and other agents over MCP' },
      { title: 'Custom skills', href: { page: '/manual/skills' }, note: 'the between-track segments, and writing your own' },
      { title: 'Acoustic analysis', href: { page: '/manual/analysis' }, note: 'BPM, key, intros and loudness, plus the optional heavy tier' },
      { title: 'Listen with', href: { page: '/manual/clients' }, note: 'iOS and Android apps, browsers, Sonos and other players' },
      { title: 'Operator CLI', href: { page: '/manual/cli' } },
      { title: 'Questions and answers', href: { page: '/manual/faq' } },
    ],
  },
  {
    title: 'Developers',
    links: [
      { title: 'README', href: { repo: 'README.md' }, note: 'features, architecture and quick start' },
      { title: 'HTTP API', href: { repo: 'docs/api.md' }, note: 'the public, station-password and admin auth classes, and the OpenAPI export' },
      { title: 'MCP server', href: { repo: 'docs/mcp-server.md' }, note: 'the tools an agent gets for requests, queueing, and putting the DJ on air' },
      { title: 'Custom skills', href: { repo: 'docs/custom-skills.md' }, note: 'the SKILL.md format and data-fetching tools' },
      { title: 'Bring your own TTS server', href: { repo: 'docs/custom-tts.md' } },
      { title: 'Deployment', href: { repo: 'docs/deployment.md' }, note: 'dev, single-host and bring-your-own-proxy shapes' },
      { title: 'Reverse-proxy recipes', href: { repo: 'docs/reverse-proxy.md' } },
      { title: 'Contributing', href: { repo: 'CONTRIBUTING.md' } },
    ],
  },
  {
    title: 'Optional',
    links: [
      { title: 'Community personas', href: { page: '/personas' }, note: 'DJ identities other operators shared' },
      { title: 'Community shows', href: { page: '/shows' } },
      { title: 'Community skills', href: { page: '/skills' } },
      { title: 'Stations', href: { page: '/stations' }, note: 'a directory of SUB/WAVE stations on air' },
      { title: 'Apps', href: { page: '/apps' }, note: 'players, bots and other clients built for SUB/WAVE' },
      { title: 'Dispatches', href: { page: '/news' }, note: 'release news and how-tos' },
      { title: 'Private station mode', href: { repo: 'docs/private-station.md' } },
      { title: 'Multi-station profiles', href: { repo: 'docs/multi-station.md' } },
      { title: 'Heavy voices and analysis', href: { repo: 'docs/tts-heavy.md' } },
      { title: 'Updating and rolling back', href: { repo: 'docs/updating.md' } },
    ],
  },
];

export interface LlmsUrlResolvers {
  page: (path: string, scope: PageScope) => string;
  endpoint: (path: string) => string;
}

const DEFAULT_RESOLVERS: LlmsUrlResolvers = {
  page: canonicalUrl,
  endpoint: absoluteUrl,
};

export function llmsHrefUrl(href: LlmsHref, urls: LlmsUrlResolvers = DEFAULT_RESOLVERS): string {
  if ('page' in href) return urls.page(href.page, href.scope ?? 'shared');
  if ('endpoint' in href) return urls.endpoint(href.endpoint);
  return `${REPO_RAW_URL}/${href.repo}`;
}

export function buildLlmsTxt(urls: LlmsUrlResolvers = DEFAULT_RESOLVERS): string {
  const lines = ['# SUB/WAVE', '', `> ${SUMMARY}`, '', 'Things to get right about SUB/WAVE:', ''];
  for (const fact of FACTS) lines.push(`- ${fact}`);
  for (const section of LLMS_SECTIONS) {
    lines.push('', `## ${section.title}`, '');
    for (const link of section.links) {
      const note = link.note ? `: ${link.note}` : '';
      lines.push(`- [${link.title}](${llmsHrefUrl(link.href, urls)})${note}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
