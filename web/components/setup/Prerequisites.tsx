import Link from 'next/link';
import SetupPage from './SetupPage';

export default function Prerequisites() {
  return (
    <SetupPage
      eyebrow="SETUP · 01"
      title="Have these ready."
      intro="SUB/WAVE doesn't ship Navidrome or Ollama; it talks to yours. Get them running first if they aren't already, and note the URLs and credentials. The install wizard will ask for them."
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
            </p>
          </li>
          <li>
            <strong>Navidrome, or any Subsonic-API server.</strong>
            <p>
              SUB/WAVE plays from your library, reachable from wherever the stack
              runs. Note the URL, username, and password. The wizard asks for all
              three.{' '}
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
              (qwen3.5, qwen3.6, or gemma4 all work). Note the URL and model name.
              Prefer a hosted model? Anthropic, OpenAI, Google, OpenRouter, and
              DeepSeek are all supported; you pick the provider and supply its key
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
      </section>
    </SetupPage>
  );
}
