import EditorialReveal from '../landing/EditorialReveal';
import { cn } from '@/lib/cn';

// A small tag chip, matching the broadsheet pill box used in the Navidrome
// "also works with" row. The accent variant swaps the border + ink to
// vermilion to flag the headline capability (voice cloning).
function Pill({ children, accent }: { children: string; accent?: boolean }) {
  return (
    <span
      className={cn(
        'inline-block border px-[9px] py-[3px] text-[11px] tracking-[0.04em]',
        accent ? 'border-vermilion text-vermilion' : 'border-separator-strong text-ink',
      )}
    >
      {children}
    </span>
  );
}

const BRAINS = [
  'Ollama',
  'Anthropic',
  'OpenAI',
  'Google',
  'DeepSeek',
  'OpenRouter',
  'Requesty',
  'Vercel Gateway',
  'OpenAI-compatible',
];

const VOICES = ['Piper', 'Kokoro', 'Chatterbox', 'PocketTTS', 'OpenAI', 'ElevenLabs'];

export default function YourStack() {
  return (
    <EditorialReveal className="bs-section">
      <p className="bs-eyebrow">PART THREE · THE STACK</p>
      <h2>Bring your own brain. Bring your own voice.</h2>
      <p className="text-muted">
        The mind that picks the tracks and the voice that reads them out are two
        separate, swappable seams. Choose a language model, choose a speech
        engine, clone a voice if you want one. Change either in the console and
        the next line on air uses it. No redeploy.
      </p>

      <div className="bs-whatis-grid mt-4">
        <article className="bs-whatis-card">
          <div className="bs-eyebrow mb-2">THE BRAIN · LLM</div>
          <h3 className="m-0 mb-[10px] text-[clamp(20px,2.2vw,26px)] leading-[1.15] font-extrabold tracking-[-0.02em]">
            Any model can run the booth.
          </h3>
          <p className="m-0 text-[14px] leading-[1.55] text-muted">
            Every pick, every intro, every weather read goes through one
            provider-agnostic seam. The default is a local Ollama box: private,
            no API key, nothing leaves the house. Prefer a hosted model, an
            aggregator with one key for every vendor, or your own
            OpenAI-compatible server (llama.cpp, vLLM, LM Studio)? The call sites
            never name a provider, so switching is a single dropdown.
          </p>
          <div className="mt-4 flex flex-wrap gap-[6px]">
            {BRAINS.map((b) => (
              <Pill key={b}>{b}</Pill>
            ))}
          </div>
        </article>

        <article className="bs-whatis-card">
          <div className="bs-eyebrow mb-2">THE VOICE · TTS</div>
          <h3 className="m-0 mb-[10px] text-[clamp(20px,2.2vw,26px)] leading-[1.15] font-extrabold tracking-[-0.02em]">
            And any voice can read it out.
          </h3>
          <p className="m-0 text-[14px] leading-[1.55] text-muted">
            Local engines run on-device: Piper is the fast default and the
            safety net, Kokoro trades speed for a warmer read. Or stream a cloud
            voice from OpenAI or ElevenLabs. Every persona carries its own voice,
            and you can hand a different one to each kind of segment, so the
            station ID need not sound like the late-night host.
          </p>
          <div className="mt-4 flex flex-wrap gap-[6px]">
            {VOICES.map((v) => (
              <Pill key={v}>{v}</Pill>
            ))}
          </div>
        </article>
      </div>

      <div className="bs-whatis-card mt-4">
        <div className="bs-eyebrow mb-2">VOICE CLONING</div>
        <h3 className="m-0 mb-[10px] text-[clamp(20px,2.2vw,26px)] leading-[1.15] font-extrabold tracking-[-0.02em]">
          Give a host a voice of its own.
        </h3>
        <p className="m-0 max-w-[64ch] text-[14px] leading-[1.55] text-muted">
          Drop a short reference clip in the voices folder, point a persona at
          it, and that DJ speaks in the cloned voice from the next line on.
          Chatterbox does it zero-shot from a single WAV (and renders
          paralinguistic cues like a laugh or a sigh); PocketTTS clones from a{' '}
          <code className="text-[13px]">.wav</code> too; and a custom Piper voice
          pair drops straight in. The 3am host can sound like anyone you have a
          clip of, entirely on your own box.
        </p>
        <div className="mt-4 flex flex-wrap gap-[6px]">
          <Pill accent>Zero-shot cloning</Pill>
          <Pill>Per-persona voices</Pill>
          <Pill>Per-segment voices</Pill>
          <Pill>Runs on-device</Pill>
        </div>
      </div>
    </EditorialReveal>
  );
}
