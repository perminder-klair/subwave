import Link from 'next/link';
import ManualPage from './ManualPage';
import CodeBlock from "@/components/CodeBlock";

export default function Voices() {
  return (
    <ManualPage
      eyebrow="MANUAL · 12"
      title="Voices & TTS."
      intro="The DJ's words are written by the language model, but turning them into speech is a separate job. Six text-to-speech engines render the voice: four built in, one hosted, and one a TTS server you run yourself. You can mix them per segment, clone a voice, point at your own server, or hand the heavy one to a GPU."
      current="/manual/voices"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">THE ENGINES</p>
        <h2>Local voices, or the cloud.</h2>
        <p>
          You pick the engine under <strong>Admin &rarr; TTS voice</strong>. Four are
          built in, one is hosted, and one points at a server you run yourself.
        </p>
        <ul className="bs-list">
          <li>
            <strong>Piper</strong> is the default. It's compact, runs on practically any
            hardware, and renders speech faster than real time. The voice is clear but a
            little synthetic. It also doubles as the station's safety net (see below).
          </li>
          <li>
            <strong>Kokoro</strong> is a local neural model that sounds markedly more
            natural, closer to a real broadcaster. It's heavier: it loads a model into
            memory and takes longer per line, so it wants a bit of CPU and RAM headroom.
            It ships a range of voices, with a British selection surfaced in the console.
          </li>
          <li>
            <strong>Chatterbox</strong> clones a voice from a short reference clip, so each
            persona can have its own distinct sound, and it voices paralinguistic cues like{' '}
            <em>[laugh]</em> and <em>[sigh]</em> as real sounds. It's the most capable
            local engine and the heaviest: comfortable on a GPU, slow on CPU. It lives in
            the optional <code className="bs-code-inline">tts-heavy</code> sidecar.
          </li>
          <li>
            <strong>PocketTTS</strong> is a small, multilingual model from kyutai-labs that
            runs about six times faster than real time on CPU, with built-in voices in
            English, French, German, Italian, Spanish and Portuguese. It sits between Piper
            (fast, robotic) and Chatterbox (heavy, expressive), in the same{' '}
            <code className="bs-code-inline">tts-heavy</code> sidecar.
          </li>
          <li>
            <strong>Cloud</strong> is hosted text-to-speech through OpenAI or ElevenLabs,
            using an API key. It's the most lifelike of the six, but it costs per use and
            depends on the network being up. The Cloud engine also speaks{' '}
            <strong>OpenAI-compatible</strong>, so it can point at any self-hosted speech
            server, including a Chatterbox box on your own GPU (see below).
          </li>
          <li>
            <strong>Remote</strong> is a TTS server you run yourself — a LAN box, a
            Tailscale host, a spare GPU — that speaks a tiny Subwave-native HTTP
            contract. It's the clean way to self-host an engine like Qwen3-TTS, F5-TTS
            or CosyVoice without dressing it up as another provider (see below).
          </li>
        </ul>
        <p>
          You don't have to commit to one. The operator can assign a different engine{' '}
          <em>per kind</em> of segment (a rich cloud voice for station IDs, say, but a
          fast local voice for routine time checks), with everything else falling through
          to a default engine.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">THE DJ NEVER GOES SILENT</div>
          <p>
            If a voice ever fails (a cloud outage, a model that isn't installed), the
            station drops to a local engine automatically. Piper is always there as the
            last resort, so a spoken segment is never lost to a missing voice.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">CHATTERBOX &amp; POCKETTTS</p>
        <h2>Enabling the tts-heavy sidecar.</h2>
        <p>
          Piper and Kokoro ship inside the controller image, and the cloud engine just
          needs an API key. Chatterbox and PocketTTS are the exceptions: they drag in a
          few GB of PyTorch and model weights between them, so they live in a separate,
          opt-in <code className="bs-code-inline">tts-heavy</code> container rather than
          being bundled into every install.
        </p>
        <p>
          To enable, set <code className="bs-code-inline">COMPOSE_PROFILES=tts-heavy</code>{' '}
          in your <code className="bs-code-inline">.env</code> and bring the stack up:
        </p>
        <CodeBlock>{`echo COMPOSE_PROFILES=tts-heavy >> .env
docker compose up -d`}</CodeBlock>
        <p>
          For a one-off start without persisting the choice, run{' '}
          <code className="bs-code-inline">docker compose --profile tts-heavy up -d</code>{' '}
          instead. The setup wizard at <code className="bs-code-inline">/onboarding</code>{' '}
          also writes the env var for you if you tick &ldquo;Enable Chatterbox +
          PocketTTS&rdquo;.
        </p>
        <p>
          Once the sidecar is up, both engines show as available under{' '}
          <strong>Admin &rarr; TTS voice</strong>. For voice cloning (Chatterbox or
          PocketTTS), drop a short reference WAV into{' '}
          <code className="bs-code-inline">state/voices/</code>{' '}
          (legacy <code className="bs-code-inline">state/chatterbox-voices/</code> is
          still read) and pick it on the Personas page. Without one, both engines use
          their built-in default voice. PocketTTS also exposes a curated set of built-in
          voice ids (<code className="bs-code-inline">alba</code>,{' '}
          <code className="bs-code-inline">anna</code>,{' '}
          <code className="bs-code-inline">charles</code>, …) alongside any cloned voices.
          Until the sidecar is started, selecting either engine silently falls back to
          Piper.
        </p>
        <p>
          Both engines load when the sidecar starts, but each is a separate PyTorch
          model that costs memory and a first-boot weight download. If you only use one,
          name it in <code className="bs-code-inline">.env</code> and the other never
          loads &mdash; comma-separated, defaulting to both:
        </p>
        <CodeBlock>{`TTS_HEAVY_ENGINES=pocket-tts       # PocketTTS only (no Chatterbox)
# TTS_HEAVY_ENGINES=chatterbox     # Chatterbox only
# TTS_HEAVY_ENGINES=chatterbox,pocket-tts   # default — both`}</CodeBlock>
        <p>
          Bring the sidecar back up after changing it. If a persona is still pointed at
          the disabled engine, its speech falls back to Piper rather than failing.
        </p>
        <p className="text-muted">
          For backwards compatibility, the older{' '}
          <code className="bs-code-inline">--build-arg WITH_CHATTERBOX=1</code> /{' '}
          <code className="bs-code-inline">WITH_POCKETTTS=1</code> paths in{' '}
          <code className="bs-code-inline">docker/Dockerfile.controller</code> still work.
          They bundle the engines inside the controller image instead, but the sidecar is
          the recommended path for fresh installs.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">REMOTE</p>
        <h2>Your own TTS server.</h2>
        <p>
          The <strong>Remote</strong> engine points SUB/WAVE at a TTS server you run
          yourself, anywhere the controller can reach over the network — a LAN box, a
          Tailscale host, a spare GPU machine. Unlike the OpenAI-compatible Cloud route
          (which speaks OpenAI&apos;s{' '}
          <code className="bs-code-inline">/v1/audio/speech</code>), Remote speaks a tiny
          Subwave-native contract, so wrapping a model like Qwen3-TTS, F5-TTS or CosyVoice
          in a server is only a few lines.
        </p>
        <p>
          Configure it under <strong>Admin &rarr; TTS voice</strong>: pick{' '}
          <strong>Remote</strong> and set <strong>Server URL</strong> to the endpoint
          (e.g. <code className="bs-code-inline">http://192.168.1.101:5001</code>, a LAN or
          Tailscale IP the controller container can reach, not{' '}
          <code className="bs-code-inline">127.0.0.1</code>). The console shows{' '}
          <strong>ready</strong> once the health check passes, and the station falls back
          to Piper whenever the URL is blank or the server is down. A persona&apos;s{' '}
          <strong>Remote voice</strong> is free text forwarded straight to your server — a
          voice id, a reference-WAV filename, a VoiceDesign prompt, whatever it
          understands.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">THE CONTRACT</div>
          <p>
            Your server needs two routes.{' '}
            <code className="bs-code-inline">GET /health</code> returns{' '}
            <code className="bs-code-inline">{`{ "ok": true }`}</code> when it&apos;s ready.{' '}
            <code className="bs-code-inline">POST /speak</code> takes JSON{' '}
            <code className="bs-code-inline">{`{ "text": "…", "voice": "…" }`}</code> and
            returns the rendered audio (WAV) <em>in the response body</em>. The audio
            travels over the wire, so no shared filesystem or volume is needed — that&apos;s
            the difference from the bundled{' '}
            <code className="bs-code-inline">tts-heavy</code> sidecar, which hands back a
            path on a shared volume.
          </p>
        </div>
        <p>That&apos;s the whole server — for example, in Flask:</p>
        <CodeBlock>{`@app.get("/health")
def health():
    return {"ok": True}

@app.post("/speak")
def speak():
    body  = request.get_json()
    text  = body["text"]
    voice = body.get("voice", "")
    wav   = my_model.render(text, voice)        # -> WAV bytes
    return Response(wav, mimetype="audio/wav")`}</CodeBlock>
        <p className="text-muted">
          Optional: if your server substitutes a different voice than the one requested,
          set the <code className="bs-code-inline">X-TTS-Fell-Back</code> response header
          (plus <code className="bs-code-inline">X-TTS-Voice-Used</code> and{' '}
          <code className="bs-code-inline">X-TTS-Fell-Back-Reason</code>) and SUB/WAVE logs
          the substitution instead of leaving you to guess why the voice changed.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">CHATTERBOX ON A GPU</p>
        <h2>When CPU isn't enough.</h2>
        <p>
          Chatterbox is the most expressive local engine and the most demanding. On a CPU
          it pegs every core and still runs slower than real time. If you have a GPU there
          are two ways to put it to work, and the easy one needs no rebuild at all.
        </p>

        <p>
          <strong>The easy route: your own server over the OpenAI layer.</strong>{' '}
          Run a Chatterbox server that exposes an OpenAI-compatible{' '}
          <code className="bs-code-inline">/v1/audio/speech</code> endpoint on your GPU
          machine (the community <em>Chatterbox TTS API</em> project does exactly this),
          then point SUB/WAVE's Cloud engine at it. Under{' '}
          <strong>Admin &rarr; TTS voice</strong>, set the Cloud engine's{' '}
          <strong>Provider</strong> to{' '}
          <code className="bs-code-inline">OpenAI-compatible</code>, put the box's address
          in <strong>Server base URL</strong> (e.g.{' '}
          <code className="bs-code-inline">http://192.168.1.101:5000/v1</code>, including
          the <code className="bs-code-inline">/v1</code>, on a LAN or Tailscale IP the
          controller container can reach rather than{' '}
          <code className="bs-code-inline">127.0.0.1</code>), and set{' '}
          <strong>Model</strong> to the id the server reports at{' '}
          <code className="bs-code-inline">/v1/models</code>. The DJ now speaks through
          your GPU with no image rebuild.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">CLONING STILL WORKS, SERVER-SIDE</div>
          <p>
            The OpenAI speech API has no field for a per-request reference clip, but
            SUB/WAVE still forwards the persona's voice <em>name</em>. So you register your
            reference clip as a named voice on the Chatterbox server (an{' '}
            <code className="bs-code-inline">optimus</code>, say) and select it by name,
            and the clone renders on your GPU. What you give up versus the native route is
            the in-app <code className="bs-code-inline">state/voices/</code> per-persona
            workflow and daypart speed shaping.
          </p>
        </div>

        <p>
          <strong>The native route: GPU-enable the bundled sidecar.</strong>{' '}
          The shipped <code className="bs-code-inline">tts-heavy</code> image installs
          CPU-only PyTorch wheels, so setting{' '}
          <code className="bs-code-inline">TTS_HEAVY_DEVICE=cuda</code> on its own silently
          falls back to CPU. To drive the card natively (and keep reference-WAV cloning),
          point the <code className="bs-code-inline">CHATTERBOX_TORCH_INDEX_URL</code> build
          arg at a CUDA wheel index and bring the sidecar up with the{' '}
          <code className="bs-code-inline">docker-compose.tts-heavy-gpu.yml</code> overlay,
          which carries the GPU reservation for you. No Dockerfile editing, just a local
          build on a host with the NVIDIA Container Toolkit.
        </p>
        <p className="text-muted">
          The full step-by-step for both routes lives in{' '}
          <code className="bs-code-inline">docs/gpu-tts.md</code> in the repo, including the
          exact build args and the compose GPU reservation. The DJ itself is unchanged
          either way; this only swaps where the Chatterbox voice is rendered. For the model
          that <em>writes</em> the show rather than speaks it, see{' '}
          <Link href="/manual/llm">Models &amp; Tokens</Link>.
        </p>
      </section>
    </ManualPage>
  );
}
