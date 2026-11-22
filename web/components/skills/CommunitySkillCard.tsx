import CatalogBrief from '@/components/ui/catalog-brief';
import Credit from '@/components/community/Credit';
import { cooldownMinutes, lotNo, maxPerDay } from '@/components/community/kit';
import type { CommunitySkill } from '@/lib/communitySkills';
import { feedHost } from '@/lib/feed-host';
import s from './skills.module.css';

// The /skills showcase, drawn as the Exchange: a ticker tape of every lot across
// the top, then each skill as a ruled cue card with a 24-hour dial showing how
// often its cooldown lets it air. Browse-only: installation happens in a
// station's admin console. Server components, no client JS.

/** 24 hour ticks round a clock; a tick lights each time the cooldown lets the skill air. */
function CooldownDial({ minutes, label }: { minutes: number | null; label?: string }) {
  const lit = new Set<number>();
  if (minutes) {
    const stepHours = minutes / 60;
    if (stepHours <= 1) for (let h = 0; h < 24; h++) lit.add(h);
    else for (let t = 0; t < 24; t += stepHours) lit.add(Math.floor(t));
  }
  return (
    <div className={s.dial}>
      <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <circle cx="32" cy="32" r="30" fill="none" stroke="var(--ink)" strokeWidth="1.5" />
        {Array.from({ length: 24 }, (_, h) => {
          const a = (h / 24) * Math.PI * 2 - Math.PI / 2;
          const on = lit.has(h);
          const r1 = on ? 19 : 23;
          const r2 = 27;
          return (
            <line
              key={h}
              x1={32 + Math.cos(a) * r1}
              y1={32 + Math.sin(a) * r1}
              x2={32 + Math.cos(a) * r2}
              y2={32 + Math.sin(a) * r2}
              stroke={on ? 'var(--accent)' : 'var(--ink)'}
              strokeOpacity={on ? 1 : 0.3}
              strokeWidth={on ? 2.6 : 1.2}
              strokeLinecap="round"
            />
          );
        })}
      </svg>
      <span className={s.dialLabel}>{label ?? '—'}</span>
    </div>
  );
}

export default function CommunitySkillCard({ skill, index }: { skill: CommunitySkill; index: number }) {
  const contexts = (skill.context || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const source = feedHost(skill.feed);
  const minutes = cooldownMinutes(skill.cooldown);
  const perDay = maxPerDay(minutes);

  return (
    <li className={s.card} id={`skill-${skill.slug}`}>
      <div className={s.cardStrip}>
        <span>Lot {lotNo(index)}</span>
        {skill.window === 'commute' && <span className={s.badge}>Rush hour only</span>}
      </div>

      <div className={s.cardHead}>
        <h3 className={s.name}>{skill.label}</h3>
        <CooldownDial minutes={minutes} label={skill.cooldown} />
      </div>

      {perDay && (
        <p className={s.cadence}>
          {skill.cooldown} cooldown · airs up to <strong>{perDay}×</strong> a day
        </p>
      )}

      <div className={s.ruled}>
        <CatalogBrief text={skill.brief} />
      </div>

      {(contexts.length > 0 || source) && (
        <dl className={s.wires}>
          {contexts.length > 0 && (
            <div>
              <dt>Wired to</dt>
              <dd>
                <ul className={s.chips}>
                  {contexts.map((c) => (
                    <li key={c} className={s.chip}>
                      <span aria-hidden="true">⌁</span> {c}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
          {source && (
            <div>
              <dt>Reads before it speaks</dt>
              <dd className={s.feed}>
                <span aria-hidden="true">⟶</span> {source}
              </dd>
            </div>
          )}
        </dl>
      )}

      <Credit by={skill.submittedBy} added={skill.dateAdded} modified={skill.dateModified} />
    </li>
  );
}

/** The ticker tape: every lot scrolling past like a market board. */
export function SkillTicker({ skills }: { skills: CommunitySkill[] }) {
  const items = skills.map((sk) => (
    <span key={sk.slug} className={s.tick}>
      <span className={s.tickSym}>{symbol(sk.slug)}</span>
      <span className={s.tickName}>{sk.label}</span>
      {sk.cooldown && (
        <span className={s.tickUp}>
          <span aria-hidden="true">▲</span> {sk.cooldown}
        </span>
      )}
    </span>
  ));
  return (
    <div className={s.ticker}>
      <span className={s.tickerTag}>
        <span className="bs-live-dot" aria-hidden="true" /> SKX
      </span>
      <div className={s.tickerWindow}>
        <div className={s.tickerTrack}>
          <div className={s.tickerRun}>{items}</div>
          {/* A second copy so the loop is seamless; screen readers get one. */}
          <div className={s.tickerRun} aria-hidden="true">
            {items}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A four-letter "stock symbol" from a slug: GOOD-NEWS → GDNW. */
function symbol(slug: string): string {
  const parts = slug.toUpperCase().split('-').filter(Boolean);
  if (parts.length >= 2) return parts.slice(0, 4).map((p) => p.slice(0, parts.length >= 4 ? 1 : 2)).join('').slice(0, 4);
  return parts[0]?.replace(/[AEIOU]/g, '').slice(0, 4) || parts[0]?.slice(0, 4) || '?';
}
