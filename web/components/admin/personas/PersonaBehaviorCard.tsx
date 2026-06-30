'use client';
// How this persona talks: talk frequency, script length, DJ style, and the tone
// dials. Two columns from lg up (settings on the left, dials on the right) so
// the knobs stay grouped instead of spreading across the full editor width.
import type { Persona } from './types';
import { FREQUENCIES, SCRIPT_LENGTHS, DJ_STYLES, TONE_DIALS, toneBandIndex } from './constants';
import { Card } from '../ui';
import { RadioOption } from './RadioOption';
import { ToneKnob } from './ToneKnob';

interface PersonaBehaviorCardProps {
  persona: Persona;
  update: (patch: Partial<Persona>) => void;
}

export function PersonaBehaviorCard({ persona, update }: PersonaBehaviorCardProps) {
  const djStyleId = persona.musicOnly ? 'music-only' : persona.djMode ? 'full-dj' : 'narrator';
  const activeDjStyle = DJ_STYLES.find(s => s.id === djStyleId)!;

  function setDjStyle(id: string) {
    if (id === 'music-only') update({ musicOnly: true, djMode: false });
    else if (id === 'full-dj') update({ musicOnly: false, djMode: true });
    else update({ musicOnly: false, djMode: false });
  }

  return (
    <Card title="Behaviour" sub="how this persona talks">
      <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-8">
        {/* LEFT — DJ style, frequency, script length */}
        <div>
          <div className="rule-label">DJ style</div>
          <div className="stack-mobile grid grid-cols-3 gap-2">
            {DJ_STYLES.map(s => (
              <RadioOption
                key={s.id}
                active={s.id === djStyleId}
                label={s.label}
                desc={s.desc}
                onSelect={() => setDjStyle(s.id)}
              />
            ))}
          </div>
          <div className="field-hint mt-2">{activeDjStyle.feedback}</div>

          <div className="rule-label">talk frequency</div>
          <div className="stack-mobile grid grid-cols-3 gap-2">
            {FREQUENCIES.map(f => (
              <RadioOption
                key={f.id}
                active={f.id === persona.frequency}
                label={f.label}
                desc={f.desc}
                onSelect={() => update({ frequency: f.id })}
              />
            ))}
          </div>

          <div className="rule-label">script length</div>
          <div className="stack-mobile grid grid-cols-2 gap-2">
            {SCRIPT_LENGTHS.map(s => (
              <RadioOption
                key={s.id}
                active={s.id === (persona.scriptLength || 'concise')}
                label={s.label}
                desc={s.desc}
                onSelect={() => update({ scriptLength: s.id })}
              />
            ))}
          </div>
        </div>

        {/* RIGHT — tone dials */}
        <div className="mt-4 lg:mt-0">
          <div className="rule-label">tone dials</div>
          <div className="grid grid-cols-3 gap-2 sm:gap-4">
            {TONE_DIALS.map(d => {
              const val = persona[d.id];
              return (
                <ToneKnob
                  key={d.id}
                  label={d.label}
                  value={val}
                  band={d.words[toneBandIndex(val)]}
                  low={d.low}
                  high={d.high}
                  onChange={v => update({ [d.id]: v } as Partial<Persona>)}
                />
              );
            })}
          </div>
          <div className="field-hint mt-3.5">
            Personality on top of the soul. The middle band (4–6) injects nothing, so the
            default stays exactly as before; turn a dial low or high to shift the voice.
          </div>
        </div>
      </div>
    </Card>
  );
}
