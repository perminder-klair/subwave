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

// The stack as a wiring manual: each swappable seam is a spec entry — dotted
// patch leader up top, the copy at full measure, a FITS rail of compatible
// engines beside it. The accent pill marks the headline capability.
const SEAMS = [
  {
    tag: 'Seam A',
    name: 'The mind',
    title: 'Any model can run the booth.',
    body:
      'Every pick, every intro, every weather read goes through one provider-agnostic seam. The default is a local Ollama box: private, no API key, nothing leaves the house. Prefer a hosted model, an aggregator with one key for every vendor, or your own OpenAI-compatible server (llama.cpp, vLLM, LM Studio)? The call sites never name a provider, so switching is a single dropdown. A daily token budget caps what a hosted model can spend; hit it, and the music keeps playing without the chatter.',
    fits: [
      'Ollama',
      'locca',
      'Anthropic',
      'OpenAI',
      'Google',
      'DeepSeek',
      'OpenRouter',
      'Requesty',
      'Vercel Gateway',
      'OpenAI-compatible',
    ],
  },
  {
    tag: 'Seam B',
    name: 'The voice',
    title: 'And any voice can read it out.',
    body:
      'Local engines run on-device: Piper is the fast default and the safety net, Kokoro trades speed for a warmer read. Or stream a cloud voice from OpenAI or ElevenLabs. Every persona carries its own voice, and you can hand a different one to each kind of segment, so the station ID need not sound like the late-night host.',
    fits: [
      'Piper',
      'Kokoro',
      'Chatterbox',
      'PocketTTS',
      'OpenAI',
      'ElevenLabs',
      'Any HTTP endpoint',
    ],
  },
] as const;

export default function YourStack() {
  return (
    <EditorialReveal className="bs-section bs-section--tight">
      <p className="bs-eyebrow">PART THREE · THE STACK</p>
      <h2>Bring your own brain. Bring your own voice.</h2>
      <p className="text-muted">
        The mind that picks the tracks and the voice that reads them out are two
        separate, swappable seams. Choose a language model, choose a speech
        engine, clone a voice if you want one. Change either in the console and
        the next line on air uses it. No redeploy.
      </p>

      <div className="mt-2">
        {SEAMS.map((s) => (
          <article key={s.tag} className="bs-seam">
            <div className="bs-seam-rule">
              <span className="bs-seam-tag">{s.tag}</span>
              <span className="bs-seam-lead" aria-hidden="true" />
              <span className="bs-seam-name">{s.name}</span>
            </div>
            <div className="bs-seam-copy">
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
            <div className="bs-seam-fits">
              <p className="bs-seam-fits-cap">Fits</p>
              {s.fits.map((f) => (
                <Pill key={f}>{f}</Pill>
              ))}
            </div>
          </article>
        ))}

        <article className="bs-seam">
          <div className="bs-seam-rule">
            <span className="bs-seam-tag">Seam B + one clip</span>
            <span className="bs-seam-lead" aria-hidden="true" />
            <span className="bs-seam-name">The clone</span>
          </div>
          <div className="bs-seam-copy">
            <h3>Give a host a voice of its own.</h3>
            <p>
              Drop a short reference clip in the voices folder, point a persona
              at it, and that DJ speaks in the cloned voice from the next line
              on. Chatterbox does it zero-shot from a single WAV (and renders
              paralinguistic cues like a laugh or a sigh); PocketTTS clones from
              a <code className="text-[13px]">.wav</code> too; and a custom
              Piper voice pair drops straight in. The 3am host can sound like
              anyone you have a clip of, entirely on your own box.
            </p>
          </div>
          <div className="bs-seam-fits">
            <p className="bs-seam-fits-cap">Fits</p>
            <Pill accent>Zero-shot cloning</Pill>
            <Pill>Per-persona voices</Pill>
            <Pill>Per-segment voices</Pill>
            <Pill>Runs on-device</Pill>
          </div>
        </article>
      </div>
    </EditorialReveal>
  );
}
