import Link from 'next/link';
import SetupPage from './SetupPage';

export default function Prerequisites() {
  return (
    <SetupPage
      eyebrow="SETUP · 01"
      title="Have these ready."
      intro="SUB/WAVE doesn't ship a music server or Ollama; it connects to yours. Get them running first if they aren't already, and write down the URLs and credentials. The install wizard asks for all of it."
      current="/setup/prerequisites"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">THE CHECKLIST</p>
        <h2>Three things SUB/WAVE talks to.</h2>
        <ul className="bs-checklist">
          <li>
            <strong>Docker on the host.</strong>
            <p>
              Docker Compose runs the stack (two containers in dev, four in
              production; icecast and liquidsoap live together in a single{' '}
              <code className="bs-code-inline">broadcast</code> container). The
              standalone <code className="bs-code-inline">subwave</code> CLI is a
              single Bun-compiled binary with no runtime dependency; no Node
              needed unless you&apos;re hacking on the source (
              <Link href="/setup/development" className="bs-link">Development</Link>).
              Getting Docker on <Link href="/setup/macos" className="bs-link">macOS</Link>,{' '}
              <Link href="/setup/windows" className="bs-link">Windows</Link> or{' '}
              <Link href="/setup/linux" className="bs-link">Linux</Link> is the
              first step of each platform page.
            </p>
          </li>
          <li>
            <strong>Your music: Navidrome, Jellyfin or Plex.</strong>
            <p>
              SUB/WAVE plays from your library, reachable from wherever the stack
              runs. Navidrome (or any Subsonic-API server) connects directly: note
              the URL, username and password. Jellyfin and Plex go through the
              bundled music router: note the URL and an API key or token. Other
              backends can be added as{' '}
              <Link href="/manual/music-sources" className="bs-link">source plugins</Link>.
              No server yet? The wizard&apos;s demo library lets you hear the
              station first.{' '}
              <a
                href="https://www.navidrome.org/"
                target="_blank"
                rel="noreferrer"
                className="bs-link"
              >
                navidrome.org ↗
              </a>
            </p>
          </li>
          <li>
            <strong>An LLM provider.</strong>
            <p>
              The DJ's words and track picks come from a language model. The
              homelab default is <strong>Ollama</strong> with a tool-capable model
              (<code>gemma4:12b</code> works well; so do qwen3.5 and qwen3.6).
              Note the URL and model name.
              Prefer a hosted model? Anthropic, OpenAI, Google, OpenRouter, and
              DeepSeek all work. You pick the provider and supply its key
              in the admin Settings UI after install, not during setup.{' '}
              <a
                href="https://ollama.com/"
                target="_blank"
                rel="noreferrer"
                className="bs-link"
              >
                ollama.com ↗
              </a>
            </p>
          </li>
        </ul>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">READY?</p>
        <h2>Pick an install path.</h2>
        <p>
          With Navidrome and an LLM reachable, head to{' '}
          <Link href="/setup/quick-start" className="bs-link">Quick Start</Link> for
          the wizard, or <Link href="/setup/manual" className="bs-link">Manual
          Install</Link> to run the commands yourself.
        </p>
        <p>
          Want it spelled out for the machine in front of you? The platform pages
          cover the same install with the host-side details filled in:{' '}
          <Link href="/setup/macos" className="bs-link">macOS</Link>,{' '}
          <Link href="/setup/windows" className="bs-link">Windows</Link>,{' '}
          <Link href="/setup/linux" className="bs-link">Linux</Link>, and{' '}
          <Link href="/setup/unraid" className="bs-link">Unraid</Link>.
        </p>
      </section>
    </SetupPage>
  );
}
