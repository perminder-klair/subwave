import Link from 'next/link';
import ManualPage from './ManualPage';
import StreamUrl from './StreamUrl';
import ListenLinks from './ListenLinks';
import CodeBlock from "@/components/CodeBlock";

// Where the "open a network stream" command lives in each VLC build. VLC's
// menus shift slightly between versions, but these paths have been stable
// for years across desktop and the mobile apps.
const VLC_PLATFORMS = [
  {
    os: 'Windows / Linux',
    path: 'Media → Open Network Stream… (Ctrl + N), paste the URL, press Play.',
  },
  {
    os: 'macOS',
    path: 'File → Open Network… (⌘ + N), paste the URL, press Open.',
  },
  {
    os: 'iOS / iPadOS',
    path: 'Open the Network tab → Open Network Stream, type the URL, tap it to play.',
  },
  {
    os: 'Android',
    path: 'Side menu → New stream, enter the URL, tap to play.',
  },
];

export default function Clients() {
  return (
    <ManualPage
      eyebrow="MANUAL · 03"
      title="Listen with other apps."
      intro="The browser player is the front door to SUB/WAVE, but it isn't the only way in. Underneath, the station is a single Icecast MP3 stream — and any app that can open an internet-radio URL can listen along, in perfect sync with everyone else."
      current="/manual/clients"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">iOS &amp; ANDROID</p>
        <h2>The app on your phone.</h2>
        <p>
          SUB/WAVE has native players for iOS and Android. They mirror the
          browser player rather than just carrying the audio: now-playing with cover
          art and a live visualiser, the booth feed, the timeline, a request form, the
          schedule, and station themes that recolour the whole app. Playback keeps going in
          the background, with controls on the lock screen, your headphones, CarPlay, and
          Android Auto.
        </p>
        <p>
          They open on the public station, and you can add any other SUB/WAVE station by its
          address: the same <code className="bs-code-inline">/stream.mp3</code> domain
          the apps below use, typed in once and saved.
        </p>
        <p className="text-muted">
          Both are live in their stores: download from the App Store on iPhone and
          iPad, or Google Play on Android. Install it like any other app, and it
          auto-updates from then on.
        </p>
        <table className="bs-doc-table">
          <thead>
            <tr>
              <th>Platform</th>
              <th>How to get it</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Android</strong></td>
              <td>
                <a
                  href="https://play.google.com/store/apps/details?id=com.getsubwave.app"
                  className="bs-link"
                  target="_blank"
                  rel="noreferrer"
                >
                  Google Play ↗
                </a>
              </td>
            </tr>
            <tr>
              <td><strong>iOS</strong></td>
              <td>
                <a
                  href="https://apps.apple.com/app/sub-wave/id6778786696"
                  className="bs-link"
                  target="_blank"
                  rel="noreferrer"
                >
                  App Store ↗
                </a>
              </td>
            </tr>
          </tbody>
        </table>
        <div className="bs-callout">
          <div className="bs-eyebrow">NOT JUST THIS STATION</div>
          <p>
            The apps default to the public station, but they aren&rsquo;t tied to it. Add
            any other SUB/WAVE instance by its address and switch between saved stations
            from inside the app &mdash; the same way you&rsquo;d point the audio-only
            players below at a stream URL.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE ONE THING YOU NEED</p>
        <h2>The stream URL.</h2>
        <p>
          Every external player asks for the same thing: the address of the stream. For
          this station it is <code className="bs-code-inline">/stream.mp3</code> on the
          station&rsquo;s own domain:
        </p>
        <StreamUrl />
        <p className="text-muted">
          Paste that into any of the apps below. It is a live broadcast, so there is no
          pause and no seek. Closing the app and reopening it drops you back
          wherever the station is <em>now</em>, not where you left off.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">OPUS, IF YOUR PLAYER SUPPORTS IT</div>
          <p>
            The station also serves <code className="bs-code-inline">/stream.opus</code>{' '}
            (Ogg-Opus, 96&nbsp;kbps) on the same domain. It sounds equal-or-better and uses
            roughly half the bandwidth of the MP3 mount. The in-browser player picks it
            automatically when supported; for external apps try Opus first and fall back
            to MP3 if the player refuses it. MP3 stays the universal recommendation for
            Sonos, hardware internet radios, car receivers, and older mobile devices.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE EVEN EASIER WAY</p>
        <h2>One-tap tune-in links.</h2>
        <p>
          Some players — Sonos, moOde, hardware internet radios, car receivers —
          want a <em>playlist file</em>, not a bare stream address. The station
          serves both, each a one-line wrapper around the{' '}
          <code className="bs-code-inline">/stream.mp3</code> mount above:
        </p>
        <ListenLinks />
        <p className="text-muted">
          Paste either link where the player asks for a station or stream URL and it
          tunes straight in — no need to type the raw address.{' '}
          <code className="bs-code-inline">.pls</code> is the most widely supported
          (Sonos, VLC, foobar2000); <code className="bs-code-inline">.m3u</code> is the
          fallback for anything that prefers it. Both follow whatever domain you are
          reading this on, need no sign-in, and add the Opus mount automatically when
          the operator has enabled it.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">VLC</p>
        <h2>VLC, on every screen you own.</h2>
        <p>
          VLC is the steadiest way to tune in outside the browser. It runs on every desktop
          and mobile platform, opens the stream from a single URL, and buffers generously
          enough that a shaky connection rarely interrupts the broadcast. It is free and
          open-source: desktop builds come from{' '}
          <a
            href="https://www.videolan.org/vlc/"
            className="bs-link"
            target="_blank"
            rel="noreferrer"
          >
            videolan.org ↗
          </a>
          , and the mobile apps are <strong>VLC for Mobile</strong> on the iOS App Store
          and <strong>VLC</strong> on Google Play.
        </p>
        <p>
          Whichever device you are on, point VLC at its <em>network stream</em> option,
          not <em>open file</em>, and give it the URL above:
        </p>
        <table className="bs-doc-table">
          <thead>
            <tr>
              <th>Platform</th>
              <th>How to open the stream</th>
            </tr>
          </thead>
          <tbody>
            {VLC_PLATFORMS.map((p) => (
              <tr key={p.os}>
                <td><strong>{p.os}</strong></td>
                <td>{p.path}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          Once it is playing, VLC shows the live track and artist from the stream&rsquo;s
          metadata, the same now-playing info the browser player displays. On
          desktop you can drag the stream into the Playlist and save it as an{' '}
          <code className="bs-code-inline">.m3u</code> for one-click tuning later; on
          mobile it stays in VLC&rsquo;s history under the Network tab.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">IF THE CONNECTION IS FLAKY</div>
          <p>
            VLC&rsquo;s default buffer is short. On a weak connection, raise it: desktop
            users open <em>Preferences → Show All → Input / Codecs</em> and lift{' '}
            <strong>Network caching</strong> to 3000&nbsp;ms, or launch from a terminal
            with{' '}
            <code className="bs-code-inline">vlc --network-caching=3000 &lt;url&gt;</code>.
            A deeper buffer trades a few seconds of start-up delay for a steadier stream.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">CLIAMP</p>
        <h2>SUB/WAVE in your terminal.</h2>
        <p>
          cliamp is a terminal music player with built-in internet-radio support. Point it
          at the stream URL and the broadcast plays straight in your shell, no
          browser and no window. It is an open-source Go program; grab a release binary
          from{' '}
          <a
            href="https://github.com/bjarneo/cliamp"
            className="bs-link"
            target="_blank"
            rel="noreferrer"
          >
            github.com/bjarneo/cliamp ↗
          </a>
          , or build it from source (needs Go 1.25+):
        </p>
        <CodeBlock>{`go install github.com/bjarneo/cliamp@latest`}</CodeBlock>
        <p className="text-muted">
          On Linux you also want the ALSA bridge for your audio server:{' '}
          <code className="bs-code-inline">pipewire-alsa</code> or{' '}
          <code className="bs-code-inline">pulseaudio-alsa</code>. The MP3 mount plays
          natively in cliamp with no <code className="bs-code-inline">ffmpeg</code>{' '}
          needed; for the Opus mount cliamp will need an ffmpeg build that includes
          libopus (most distro packages do).
        </p>
        <p>Pass the station&rsquo;s stream URL straight to cliamp:</p>
        <StreamUrl prefix="cliamp " />
        <p>
          cliamp shows <code className="bs-code-inline">● Streaming</code> with a
          non-interactive seek bar, which is expected since SUB/WAVE is a live broadcast.
          Press <kbd className="bs-kbd">u</kbd> to load a different stream, or{' '}
          <kbd className="bs-kbd">R</kbd> to browse cliamp&rsquo;s own radio directory.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">IF IT JUST SITS THERE BUFFERING</div>
          <p>
            Public SUB/WAVE stations sit behind Cloudflare, which serves the stream over
            HTTP/2 in bursts. Browsers and VLC paper over that with deep buffers; a lean
            command-line player like cliamp can underrun between bursts and show{' '}
            <em>buffering</em>. The stream itself is fine. Ask the station operator
            for a direct address that skips Cloudflare (a LAN or Tailscale URL on the
            Caddy port, usually <code className="bs-code-inline">:7700</code>), which
            serves a steady HTTP/1.1 stream.
          </p>
        </div>
        <p>Through Cloudflare (HTTP/2 — may stutter in a CLI player):</p>
        <CodeBlock>{`cliamp https://radio.example.co/stream.mp3`}</CodeBlock>
        <p>
          Direct to the station on your network (HTTP/1.1 — steady), or the same over
          Tailscale:
        </p>
        <CodeBlock>{`cliamp http://192.168.1.20:7700/stream.mp3`}</CodeBlock>
        <CodeBlock>{`cliamp http://100.x.x.x:7700/stream.mp3`}</CodeBlock>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">MORE TO COME</p>
        <h2>Any internet-radio player works.</h2>
        <p>
          The native apps are the full-featured way in; VLC and cliamp are the walked-through
          audio-only examples. But none of them are special: anything that can open an
          internet-radio URL can tune in, and more client guides will be added here over time.
          Running the station yourself rather than listening along? That&rsquo;s covered in{' '}
          <Link href="/setup" className="bs-link">the setup guide</Link>.
        </p>
      </section>
    </ManualPage>
  );
}
