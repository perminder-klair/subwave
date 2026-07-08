'use client';

import { Card, Btn, Pill } from '../ui';
import CodeBlock from '../../CodeBlock';
import { notify } from '../../../lib/notify';
import type { Catalog } from './types';

interface Props {
  catalog: Catalog;
}

function CopyUrl({ url }: { url: string }) {
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); notify.info('URL copied'); }
    catch { notify.err('Could not copy'); }
  };
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 truncate text-[12px]">{url}</code>
      <Btn sm onClick={copy}>Copy</Btn>
    </div>
  );
}

export default function IntegrationsTab({ catalog }: Props) {
  const { origin, apiBase } = catalog;
  const mp3 = `${origin}/stream.mp3`;
  const nowPlaying = `${apiBase}/now-playing`;

  // Home Assistant REST sensor + a play_media script, origin substituted so
  // it's paste-ready.
  const haYaml = [
    '# configuration.yaml',
    'rest:',
    '  - resource: ' + nowPlaying,
    '    scan_interval: 15',
    '    sensor:',
    '      - name: "SUB/WAVE Now Playing"',
    '        value_template: "{{ value_json.nowPlaying.title }} — {{ value_json.nowPlaying.artist }}"',
    '        json_attributes_path: "$.nowPlaying"',
    '        json_attributes: ["title", "artist", "album"]',
    '',
    '# Play the stream on any media_player (e.g. a Chromecast/Nest speaker):',
    '# service: media_player.play_media',
    '# target: { entity_id: media_player.kitchen }',
    '# data:',
    `#   media_content_id: "${mp3}"`,
    '#   media_content_type: "music"',
  ].join('\n');

  return (
    <div className="grid gap-4">
      <Card
        title="Stream URLs"
        sub="Point any player, speaker, or hub at these. MP3 is always live; the others turn on in Settings → Streams."
      >
        <div className="grid gap-2.5">
          {catalog.streamMounts.map(m => (
            <div key={m.mount} className="border border-separator-strong bg-bg px-3 py-2.5">
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <code className="text-[12px] font-semibold">{m.mount}</code>
                <span className="caption text-muted">{m.format}</span>
                {m.enabled
                  ? <Pill tone="accent">live</Pill>
                  : <Pill>off</Pill>}
              </div>
              <div className="mb-2 text-[11px] leading-[1.5] text-muted">{m.description}</div>
              {m.enabled
                ? <CopyUrl url={`${origin}${m.mount}`} />
                : <div className="text-[11px] text-muted italic">Enable in Settings → Streams to get a URL.</div>}
            </div>
          ))}
        </div>
      </Card>

      <Card
        title="Now-playing feeds"
        sub="Poll these for live metadata — the current track, queue, and station context."
      >
        <div className="grid gap-3">
          <div>
            <div className="caption mb-1">Current track + context</div>
            <CopyUrl url={nowPlaying} />
          </div>
          <div>
            <div className="caption mb-1">Queue + history + DJ log</div>
            <CopyUrl url={`${apiBase}/state`} />
          </div>
          <div className="text-[11px] leading-[1.5] text-muted">
            Both are public JSON, no auth. See the Endpoints tab for the full response shapes.
          </div>
        </div>
      </Card>

      <Card
        title="Music Assistant"
        sub="Add SUB/WAVE as a radio station so it plays on any Music Assistant speaker (Sonos, Chromecast, AirPlay, Alexa)."
      >
        <div className="mb-2 text-[12px] leading-[1.6] text-muted">
          In Music Assistant: <b>Settings → Radio / Favorites → add a custom radio station</b>, then paste the MP3 URL.
          Music Assistant handles playback across every speaker ecosystem it supports, so you don&rsquo;t need
          per-device casting.
        </div>
        <CopyUrl url={mp3} />
      </Card>

      <Card
        title="Home Assistant"
        sub="A REST sensor for now-playing + a play_media call to send the stream to a speaker."
      >
        <CodeBlock lang="yaml">{haYaml}</CodeBlock>
      </Card>

      <Card
        title="Webhooks"
        sub="Push station events (track changes, requests, on-air segments) to other systems as they happen."
      >
        <div className="text-[12px] leading-[1.6] text-muted">
          Everything above is <b>pull</b> — you poll SUB/WAVE. Webhooks are the <b>push</b> direction: the
          station POSTs a JSON payload to your endpoint the moment an event fires. Set them up in the{' '}
          <b>Webhooks</b> tab above.
        </div>
      </Card>
    </div>
  );
}
