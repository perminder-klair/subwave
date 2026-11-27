import CatalogBrief from '@/components/ui/catalog-brief';
import Credit from '@/components/community/Credit';
import { lotNo } from '@/components/community/kit';
import type { CommunityPlugin } from '@/lib/plugins';
import s from './plugins.module.css';

// The /plugins directory, drawn as the Patch Bay: each plugin is a jack on the
// panel, labelled with what it plugs the station into. The card states only
// what the submission proved (the API it targets, the version it was checked
// against, the conformance counts) and repeats the warning that matters: a
// plugin is code, so the way in is its source, never an install button.

const OUTCOMES = ['pass', 'warn', 'fail', 'skip'] as const;
const OUTCOME_LABEL: Record<(typeof OUTCOMES)[number], string> = {
  pass: 'passed',
  warn: 'warnings',
  fail: 'failed',
  skip: 'skipped',
};

export default function PluginCard({ plugin, index }: { plugin: CommunityPlugin; index: number }) {
  const c = plugin.conformance;
  return (
    <li className={s.card} id={`plugin-${plugin.slug}`}>
      <div className={s.cardStrip}>
        <span>Jack {lotNo(index)}</span>
        <span className={s.badge}>API v{plugin.apiVersion}</span>
      </div>

      <div className={s.socket}>
        <span className={s.socketHole} aria-hidden="true" />
        <span className={s.socketLabel}>
          <span className={s.socketEyebrow}>Plugs into</span>
          <span className={s.socketName}>{plugin.connectsTo}</span>
        </span>
      </div>

      <div className={s.body}>
        <h3 className={s.name}>
          <a href={plugin.repo} target="_blank" rel="noreferrer noopener" className={s.nameLink}>
            {plugin.name}
          </a>
        </h3>

        <CatalogBrief text={plugin.description} />

        <dl className={s.facts}>
          <div>
            <dt>Folder</dt>
            <dd>
              <code>plugins/{plugin.plugin}/</code>
            </dd>
          </div>
          <div>
            <dt>Checked with</dt>
            <dd>{plugin.checkedWith ? `SUB/WAVE ${plugin.checkedWith}` : 'Not stated'}</dd>
          </div>
          {plugin.hostFiles && (
            <div>
              <dt>Needs</dt>
              <dd>A folder mounted into the router</dd>
            </div>
          )}
        </dl>

        {c ? (
          <div className={s.meter}>
            <span className={s.meterTitle}>Conformance kit</span>
            <ul className={s.meterRow}>
              {OUTCOMES.map((o) => (
                <li key={o} className={s.meterCell} data-outcome={o} data-zero={c[o] === 0 || undefined}>
                  <span className={s.meterCount}>{c[o]}</span>
                  <span className={s.meterLabel}>{OUTCOME_LABEL[o]}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className={s.unchecked}>No conformance result on file.</p>
        )}

        <div className={s.foot}>
          <p className={s.warn}>Plugins are code that runs in your router. Read it before you install it.</p>
          <p className={s.links}>
            <a href={plugin.repo} target="_blank" rel="noreferrer noopener" className={s.get}>
              Read the source<span className="sr-only"> of {plugin.name}</span> <span aria-hidden="true">→</span>
            </a>
          </p>
          <Credit
            by={plugin.author}
            added={plugin.submitted}
            linkHandle={plugin.author?.startsWith('@') ?? false}
            className={s.credit}
          />
        </div>
      </div>
    </li>
  );
}
