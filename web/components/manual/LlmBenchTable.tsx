// The living model-results table on /manual/llm — rendered from
// web/lib/llm-bench-results.json, which is regenerated from llm-bench report
// files via `npm run llm-bench:publish` in controller/ (measured fields) plus
// hand-curated verdict/notes (preserved across re-publishes). Server-rendered;
// magnitude is encoded by bar length in a single ink hue (identity lives in
// the row, never in bar colour), and every value is also present as text.

import data from '../../lib/llm-bench-results.json';

interface GroupScore {
  ok: number;
  total: number;
}

interface BenchRow {
  model: string;
  route: string;
  benchedAt: string;
  iterations: number | null;
  reasoning: string | boolean | null;
  coverage: string;
  overall: GroupScore;
  groups: Record<string, GroupScore>;
  poolPickP50s: number | null;
  verdict: string;
  notes: string;
}

// Full literal class strings (not template-composed) so the tailwind class
// linter can verify each against the stylesheet.
const CHIP_CLASS: Record<string, string> = {
  'agent-capable': 'bs-bench-chip bs-bench-chip--agent-capable',
  'pool-mode': 'bs-bench-chip',
  avoid: 'bs-bench-chip bs-bench-chip--avoid',
};

const GROUP_COLUMNS: Array<{ key: string; label: string }> = [
  { key: 'pickPool', label: 'Picks · pool' },
  { key: 'pickAgent', label: 'Picks · agent' },
  { key: 'segPool', label: 'Segments · pool' },
  { key: 'segAgent', label: 'Segments · agent' },
  { key: 'requests', label: 'Requests' },
  { key: 'scripts', label: 'Scripts' },
  { key: 'shows', label: 'Shows' },
];

function pct(s: GroupScore | undefined): number | null {
  if (!s || !s.total) return null;
  return Math.round((100 * s.ok) / s.total);
}

function Bar({ score }: { score: GroupScore | undefined }) {
  const p = pct(score);
  if (p === null) return <span className="bs-bench-na">—</span>;
  return (
    <span className="bs-bench-cell" title={`${score!.ok}/${score!.total} runs passed`}>
      <span className="bs-bench-bar" aria-hidden="true">
        {/* eslint-disable-next-line react/forbid-dom-props -- bar width is data-derived (pass rate %); same exemption pattern as ripple.tsx */}
        <span className="bs-bench-bar-fill" style={{ width: `${p}%` }} />
      </span>
      <span className="bs-bench-pct">{p}%</span>
    </span>
  );
}

function prettyModel(model: string): { name: string; route: string } {
  const i = model.indexOf(':');
  const route = model.slice(0, i);
  const name = model.slice(i + 1);
  const routeLabel =
    route === 'ollama' && name.endsWith(':cloud') ? 'Ollama cloud'
      : route === 'ollama' ? 'Ollama'
        : route === 'openrouter' ? 'OpenRouter'
          : route === 'locca' ? 'locca (llama.cpp)'
            : route;
  return { name: name.replace(/\.gguf$/, ''), route: routeLabel };
}

export default function LlmBenchTable() {
  const models = (data.models as BenchRow[]).filter(m => m.overall.total > 0);
  return (
    <figure className="bs-bench">
      <div className="bs-bench-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Verdict</th>
              <th scope="col">Overall</th>
              {GROUP_COLUMNS.map(g => (
                <th scope="col" key={g.key}>{g.label}</th>
              ))}
              <th scope="col">Pick p50</th>
              <th scope="col">Benched</th>
            </tr>
          </thead>
          <tbody>
            {models.map(m => {
              const { name, route } = prettyModel(m.model);
              return (
                <tr key={m.model}>
                  <th scope="row">
                    <span className="bs-bench-model">{name}</span>
                    <span className="bs-bench-route">{route}</span>
                  </th>
                  <td>
                    <span className={CHIP_CLASS[m.verdict] || 'bs-bench-chip'}>
                      {m.verdict || '—'}
                    </span>
                  </td>
                  <td><Bar score={m.overall} /></td>
                  {GROUP_COLUMNS.map(g => (
                    <td key={g.key}><Bar score={m.groups[g.key]} /></td>
                  ))}
                  <td className="bs-bench-num">
                    {m.poolPickP50s != null ? `${m.poolPickP50s}s` : '—'}
                  </td>
                  <td className="bs-bench-num">{m.benchedAt}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <figcaption>
        Pass rate per call family (share of bench runs producing valid, rule-clean output;
        bar length = pass rate). &ldquo;—&rdquo; means that family wasn&rsquo;t benched for the
        model — the local 12B ran the pool/structured kinds only, on a CPU host, so its
        latency is excluded. Pick p50 is the median pool-pick round trip as served that day.
        All rows measured with reasoning off. Last updated {data.updatedAt}.
      </figcaption>
      <ul className="bs-bench-notes">
        {models.filter(m => m.notes).map(m => (
          <li key={m.model}>
            <strong>{prettyModel(m.model).name}</strong> — {m.notes}
          </li>
        ))}
      </ul>
    </figure>
  );
}
