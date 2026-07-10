'use client';

// Doctor — /admin/doctor. Runs the controller-side health assessment, offers a
// one-click fix where a safe action exists, asks the buddy (the LLM) to review
// the report in plain English, and copies the whole thing as GitHub-ready
// Markdown. Mirrors DashPanel's adminFetch + act() pattern; primitives from ./ui.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { notify, errorMessage } from '../../lib/notify';
import { Card, Btn, Pill } from './ui';
import BoothBuddy, { type BuddyMood } from '../BoothBuddy';

// --- shapes (mirror controller/src/doctor.ts) ------------------------------

type Status = 'ok' | 'warn' | 'fail' | 'skip';
type FixId = 'refresh-playlist' | 'restart-mixer' | 'generate-jingles' | 'tag-library' | 'subsonic-reset';

interface FixAction {
  id: FixId;
  label: string;
}
interface Finding {
  label: string;
  status: Status;
  detail?: string;
  hint?: string;
  fix?: FixAction;
}
interface DoctorSection {
  name: string;
  findings: Finding[];
}
interface DoctorReport {
  t: string;
  sections: DoctorSection[];
  counts: { ok: number; warn: number; fail: number; skip: number };
}
interface ReviewPriority {
  title: string;
  severity: 'low' | 'med' | 'high';
  why: string;
  suggestedFix: string;
  // DJ Doc may tag a priority with a one-click fix; we only render the button
  // when that fix id actually appears in the current report's findings.
  fixId?: FixId | null;
}
interface DoctorReview {
  available: boolean;
  reason?: string;
  overall?: 'healthy' | 'attention' | 'critical';
  summary?: string;
  priorities?: ReviewPriority[];
}

// FixId → the existing admin POST endpoint that performs it. All are already
// implemented + admin-gated and accept an empty body.
const FIX_ENDPOINTS: Record<FixId, string> = {
  'refresh-playlist': '/dj/refresh-playlist',
  'restart-mixer': '/restart-mixer',
  'generate-jingles': '/onboarding/generate-jingles',
  'tag-library': '/tag-library',
  'subsonic-reset': '/debug/subsonic/reset',
};

// Buddy mood reflects the worst-case verdict, so the operator reads the room at
// a glance — calm when healthy, startled when something's broken.
const MOOD_BY_OVERALL: Record<NonNullable<DoctorReview['overall']>, BuddyMood> = {
  healthy: 'content',
  attention: 'curious',
  critical: 'spooked',
};

// "Headquarters" = the upstream SUB/WAVE repo. Bug reports about the software
// itself go here regardless of who runs the station, so this is intentionally
// the project repo, not a per-station setting.
const HQ_ISSUES_NEW = 'https://github.com/perminder-klair/subwave/issues/new';
// GitHub's prefilled-issue form is a GET, so the whole report rides in the URL.
// Past ~8KB the request 414s / silently truncates; stay well under and fall
// back to the clipboard when the report is too big to prefill safely.
const HQ_URL_LIMIT = 7000;

function tallyCounts(sections: DoctorSection[]): DoctorReport['counts'] {
  const c = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const s of sections) for (const f of s.findings) c[f.status]++;
  return c;
}

// Parse one SSE frame ("event: …\ndata: …") into its event name + JSON payload.
function parseSseFrame(frame: string): { event: string | null; data: unknown } {
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  let data: unknown = null;
  if (dataLines.length) {
    try { data = JSON.parse(dataLines.join('\n')); } catch { /* keep null */ }
  }
  return { event, data };
}

export default function DoctorPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [review, setReview] = useState<DoctorReview | null>(null);
  const [running, setRunning] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [busyFix, setBusyFix] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // True until the mount hydration from /doctor/last resolves — suppresses the
  // intro hero flashing before a cached report loads in.
  const [hydrating, setHydrating] = useState(true);

  const ready = hydrated && !needsAuth;

  // Hydrate from the last cached run so navigating back to DJ Doc (or a nightly
  // auto-run) shows the previous report immediately instead of a blank slate.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!ready || hydratedRef.current) return;
    hydratedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch('/doctor/last');
        const j = (await r.json().catch(() => null)) as
          | { report?: DoctorReport | null; review?: DoctorReview | null }
          | null;
        if (!cancelled && j?.report) {
          setReport(j.report);
          if (j.review) setReview(j.review);
        }
      } catch {
        /* no cached run — the intro hero shows instead */
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, adminFetch]);

  // Fix actions present in the current report, keyed by id — the source of truth
  // for both the finding buttons' labels and whether a review priority may show
  // its own one-click fix button (a fixId not in this map is never surfaced).
  const fixById = useMemo(() => {
    const m = new Map<FixId, FixAction>();
    report?.sections.forEach((s) =>
      s.findings.forEach((f) => {
        if (f.fix && !m.has(f.fix.id)) m.set(f.fix.id, f.fix);
      }),
    );
    return m;
  }, [report]);

  // One-shot batch run — the fallback when SSE streaming isn't available.
  const runBatch = async (): Promise<DoctorReport | null> => {
    const r = await adminFetch('/doctor');
    const j = (await r.json().catch(() => null)) as DoctorReport | { error?: string } | null;
    if (!r.ok || !j || !('sections' in j)) {
      throw new Error((j as { error?: string })?.error || `failed (${r.status})`);
    }
    setReport(j);
    return j;
  };

  const run = async (): Promise<DoctorReport | null> => {
    setRunning(true);
    setErr(null);
    // A fresh run invalidates the previous review (it described the old report).
    setReview(null);
    try {
      // Stream sections as each check finishes so findings paint progressively.
      const r = await adminFetch('/doctor/stream', { headers: { Accept: 'text/event-stream' } });
      if (!r.ok || !r.body) throw new Error(`stream unavailable (${r.status})`);
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const sections: DoctorSection[] = [];
      let final: DoctorReport | null = null;
      // Empty shell first so the intro hero yields to the progressive report.
      setReport({ t: new Date().toISOString(), sections: [], counts: tallyCounts([]) });
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const { event, data } = parseSseFrame(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
          if (event === 'section' && data) {
            sections.push(data as DoctorSection);
            setReport({ t: new Date().toISOString(), sections: [...sections], counts: tallyCounts(sections) });
          } else if (event === 'done' && data) {
            final = data as DoctorReport;
            setReport(final);
          } else if (event === 'error') {
            throw new Error((data as { error?: string })?.error || 'doctor failed');
          }
        }
      }
      return final ?? (sections.length ? { t: new Date().toISOString(), sections, counts: tallyCounts(sections) } : null);
    } catch {
      // Streaming failed (proxy, older controller, aborted body) — fall back to
      // the single-shot endpoint so the check still works.
      try {
        return await runBatch();
      } catch (e2) {
        setErr(errorMessage(e2));
        return null;
      }
    } finally {
      setRunning(false);
    }
  };

  // `rep` lets a caller pass the just-fetched report directly — `run()` sets it
  // via setState, which isn't visible in the same tick, so the "Let's go" chain
  // hands it through rather than reading stale `report` from the closure.
  const askReview = async (rep?: DoctorReport) => {
    const target = rep ?? report;
    if (!target) return;
    setReviewing(true);
    try {
      const r = await adminFetch('/doctor/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report: target }),
      });
      const j = (await r.json().catch(() => null)) as DoctorReview | { error?: string } | null;
      if (!r.ok || !j) throw new Error((j as { error?: string })?.error || `failed (${r.status})`);
      setReview(j as DoctorReview);
      if (!(j as DoctorReview).available) {
        notify.info((j as DoctorReview).reason || 'review unavailable');
      }
    } catch (e) {
      notify.err(`buddy review: ${errorMessage(e)}`);
    } finally {
      setReviewing(false);
    }
  };

  // The one-press init flow: run the full assessment, then immediately hand the
  // fresh report to DJ Doc for his read — no separate "review" click needed.
  const letsGo = async () => {
    const rep = await run();
    if (rep) await askReview(rep);
  };

  const runFix = async (fix: FixAction) => {
    setBusyFix(fix.id);
    try {
      const r = await adminFetch(FIX_ENDPOINTS[fix.id], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      notify.ok(`${fix.label} done`);
      await run(); // re-assess so the finding clears (or shows what's left)
    } catch (e) {
      notify.err(`${fix.label}: ${errorMessage(e)}`);
    } finally {
      setBusyFix(null);
    }
  };

  const copyMarkdown = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(toMarkdown(report, review));
      notify.ok('report copied — paste into a GitHub issue');
    } catch (e) {
      notify.err(`copy failed: ${errorMessage(e)}`);
    }
  };

  // Open a GitHub "new issue" form prefilled with the diagnostics. This only
  // opens the form — nothing is filed until the operator hits Submit on GitHub.
  const sendToHQ = async () => {
    if (!report) return;
    const title = `Station diagnostics — ${report.counts.fail} fail · ${report.counts.warn} warn · ${report.counts.skip} skip`;
    const body = `_Filed from DJ Doc (Admin → DJ Doc → station health)._\n\n${toMarkdown(report, review)}`;
    const full = `${HQ_ISSUES_NEW}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    // Too long to ride in the URL — copy the full report and prefill a pointer
    // so the operator just pastes it into the issue body.
    if (full.length > HQ_URL_LIMIT) {
      try {
        await navigator.clipboard.writeText(body);
      } catch {
        /* clipboard may be blocked; the short form still opens */
      }
      const note =
        `_Filed from DJ Doc._\n\n` +
        `**${report.counts.ok} ok · ${report.counts.warn} warn · ${report.counts.fail} fail · ${report.counts.skip} skip**\n\n` +
        `> The full report was too long to prefill — it's on your clipboard, paste it below.`;
      window.open(
        `${HQ_ISSUES_NEW}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(note)}`,
        '_blank',
        'noopener,noreferrer',
      );
      notify.info('report copied — paste it into the issue body');
      return;
    }
    window.open(full, '_blank', 'noopener,noreferrer');
  };

  const buddyMood: BuddyMood = review?.available && review.overall ? MOOD_BY_OVERALL[review.overall] : 'content';

  return (
    <div className="mx-auto max-w-[1100px] px-0 py-8 sm:px-7">
      {/* Init hero — DJ Doc introduces himself and the whole run is one press.
          The booth's-open pitch is the primary content; "Let's go" runs the
          full assessment AND his review together. Stays up through the first
          run so the CTA can show progress. */}
      {ready && !hydrating && !report && (
        <Card title="DJ Doc" sub="booth's open">
          <div className="flex items-start gap-4">
            <BoothBuddy mood="curious" size={52} />
            <div className="min-w-0 flex-1">
              <p className="text-[15px] leading-[1.65]">
                Yo — DJ Doc here, resident engineer for this station. I sit in the booth and listen to
                the whole rig like it&apos;s a record: is the low end clean, is anything clipping, is the
                mix on air or dropping out?
              </p>
              <p className="mt-3 text-[13px] tracking-[0.14em] text-muted uppercase">Here&apos;s what I run the levels on</p>
              <ul className="mt-2 flex flex-col gap-2 text-[14px] leading-[1.5]">
                <li>
                  <span className="font-bold">The brain</span>{' '}
                  <span className="text-muted">— your LLM DJ: reachable, quick enough, dialed to the right settings.</span>
                </li>
                <li>
                  <span className="font-bold">The crate</span>{' '}
                  <span className="text-muted">— Navidrome + your mood tags: connected, and stocked so the picks aren&apos;t blind.</span>
                </li>
                <li>
                  <span className="font-bold">The mix</span>{' '}
                  <span className="text-muted">— Liquidsoap &amp; Icecast: on air, clean signal, listeners served.</span>
                </li>
                <li>
                  <span className="font-bold">The voice</span>{' '}
                  <span className="text-muted">— your TTS engine, and whether it actually fits the machine you&apos;re running on.</span>
                </li>
                <li>
                  <span className="font-bold">The extras</span>{' '}
                  <span className="text-muted">— web search for artist news, your hardware&apos;s muscle, and your backups.</span>
                </li>
              </ul>
              <p className="mt-4 text-[14px] leading-[1.6]">
                Hit <span className="font-bold">Let&apos;s go</span> and I&apos;ll run the levels on all of it,
                then tell you straight what&apos;s clean, what&apos;s muddy, and the one thing to fix first. No fluff.
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <Btn
                  tone="accent"
                  lg
                  onClick={letsGo}
                  disabled={running || reviewing}
                  className="px-9 py-3.5 text-[13px]"
                >
                  {running ? 'Running the levels…' : reviewing ? 'DJ Doc is listening…' : "Let's go"}
                </Btn>
                <span className="text-[12px] leading-[1.5] text-muted">
                  Runs the full check and gets DJ Doc&apos;s read in one go.
                </span>
              </div>
              {err && <p className="mt-3 text-[13px] text-[var(--accent)]">{err}</p>}
            </div>
          </div>
        </Card>
      )}

      {/* Controls — once a report exists: counts + re-run / review / copy. */}
      {report && (
        <Card
          title="DJ Doc"
          sub="station health"
          right={
            <span className="flex items-center gap-1.5">
              <Pill tone="ink">{report.counts.ok} ok</Pill>
              {report.counts.warn > 0 && <Pill tone="accent">{report.counts.warn} warn</Pill>}
              {report.counts.fail > 0 && (
                <Pill tone="accent" className="border-[var(--accent)] bg-[var(--accent)] text-white">
                  {report.counts.fail} fail
                </Pill>
              )}
              {report.counts.skip > 0 && <Pill>{report.counts.skip} skip</Pill>}
            </span>
          }
        >
          <div>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] leading-[1.6] text-muted">
                Full assessment of the station — the LLM, Navidrome &amp; library, the broadcast chain,
                voices, capabilities, content, resources and storage. Where a safe fix exists you can
                apply it in one click.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Btn tone="accent" onClick={letsGo} disabled={running || reviewing}>
                  {running ? 'Running…' : reviewing ? 'DJ Doc is listening…' : 'Re-run Doctor'}
                </Btn>
                <Btn onClick={copyMarkdown}>Copy report as Markdown</Btn>
                <Btn
                  onClick={sendToHQ}
                  title="Open a prefilled GitHub issue with this report (you submit it)"
                >
                  Send report to Headquarters
                </Btn>
                <span className="font-mono text-[11px] text-muted">
                  last run {new Date(report.t).toLocaleTimeString()}
                </span>
              </div>
              {err && <p className="mt-3 text-[13px] text-[var(--accent)]">{err}</p>}
            </div>
          </div>
        </Card>
      )}

      {/* Spotlight slot — a live "listening" indicator while DJ Doc runs the
          report past the LLM (a 20–60s call on a local model), then his verdict.
          The animated indicator is the primary signal the action is working: a
          button-label change alone read as stalled on the long call. */}
      {reviewing ? (
        <div role="status" aria-live="polite">
          <Card className="is-spotlight mt-6" title="DJ Doc says" sub="running the levels…">
            <div className="flex items-start gap-4">
              <BoothBuddy mood="onair" size={40} />
              <div className="min-w-0 flex-1">
                <p className="text-[15px] leading-[1.65] font-bold">DJ Doc is listening…</p>
                <p className="mt-1 text-[13px] leading-[1.55] text-muted">
                  Playing your whole health report past the LLM and writing up what&apos;s clean,
                  what&apos;s muddy, and the one thing to fix first. On a local model this can take
                  20–60s — hang tight.
                </p>
                <div className="mt-4 flex flex-col gap-2.5" aria-hidden="true">
                  <div className="sw-pulse h-3 w-[90%] rounded bg-[color:var(--separator-strong)]" />
                  <div className="sw-pulse h-3 w-[76%] rounded bg-[color:var(--separator-strong)]" />
                  <div className="sw-pulse h-3 w-[60%] rounded bg-[color:var(--separator-strong)]" />
                </div>
              </div>
            </div>
          </Card>
        </div>
      ) : review ? (
        <Card
          className="is-spotlight mt-6"
          title="DJ Doc says"
          right={
            review.available && review.overall ? (
              <Pill
                tone={review.overall === 'critical' ? 'accent' : review.overall === 'attention' ? 'accent' : 'ink'}
                className={review.overall === 'critical' ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : undefined}
              >
                {review.overall}
              </Pill>
            ) : undefined
          }
        >
          {review.available ? (
            <div className="flex items-start gap-4">
              <BoothBuddy mood={buddyMood} size={40} />
              <div className="min-w-0 flex-1">
                <p className="text-[15px] leading-[1.65]">{review.summary}</p>
                {review.priorities && review.priorities.length > 0 && (
                  <ul className="mt-4 flex flex-col gap-3">
                    {review.priorities.map((p, i) => {
                      // Only offer the one-click button when DJ Doc's tagged fix
                      // actually exists in this report's findings.
                      const fix = p.fixId ? fixById.get(p.fixId) : undefined;
                      return (
                        <li key={i} className="border-l-2 border-[color:var(--separator-strong)] pl-3">
                          <div className="flex items-center gap-2">
                            <Pill
                              tone={p.severity === 'low' ? 'ink' : 'accent'}
                              className={
                                p.severity === 'high'
                                  ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                                  : undefined
                              }
                            >
                              {p.severity}
                            </Pill>
                            <span className="text-[14px] font-bold">{p.title}</span>
                          </div>
                          <p className="mt-1 text-[13px] leading-[1.55] text-muted">{p.why}</p>
                          <p className="mt-1 text-[13px] leading-[1.55]">
                            <span className="font-bold">Fix:</span> {p.suggestedFix}
                          </p>
                          {fix && (
                            <div className="mt-2">
                              <Btn sm onClick={() => runFix(fix)} disabled={busyFix === fix.id}>
                                {busyFix === fix.id ? '…' : fix.label}
                              </Btn>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          ) : (
            <p className="text-[13px] text-muted">
              DJ Doc can&apos;t review right now — {review.reason || 'the LLM is offline'}. Fix the LLM
              connection (Settings → LLM) and try again.
            </p>
          )}
        </Card>
      ) : null}

      {/* Findings by section */}
      {report?.sections.map((sec) => (
        <Card key={sec.name} className="mt-6" title={sec.name}>
          <ul className="flex flex-col divide-y divide-[color:var(--separator-strong)]">
            {sec.findings.map((f, i) => (
              <li key={`${sec.name}-${f.label}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 first:pt-0 last:pb-0">
                <StatusPill status={f.status} />
                <span className="text-[14px] font-bold">{f.label}</span>
                {f.detail && <span className="font-mono text-[12px] text-muted">{f.detail}</span>}
                {f.fix && (
                  <span className="ml-auto">
                    <Btn sm onClick={() => runFix(f.fix as FixAction)} disabled={busyFix === f.fix.id}>
                      {busyFix === f.fix.id ? '…' : f.fix.label}
                    </Btn>
                  </span>
                )}
                {f.hint && <p className="w-full text-[12px] leading-[1.5] text-muted">{f.hint}</p>}
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

function StatusPill({ status }: { status: Status }) {
  if (status === 'fail') {
    return (
      <Pill tone="accent" dot className="border-[var(--accent)] bg-[var(--accent)] text-white">
        fail
      </Pill>
    );
  }
  if (status === 'warn') {
    return (
      <Pill tone="accent" dot>
        warn
      </Pill>
    );
  }
  if (status === 'ok') {
    return (
      <Pill tone="ink" dot>
        ok
      </Pill>
    );
  }
  return <Pill dot>skip</Pill>;
}

// Build a GitHub-issue-ready Markdown report from the diagnostics (+ review).
function toMarkdown(report: DoctorReport, review: DoctorReview | null): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  const lines: string[] = [];
  lines.push('## SUB/WAVE diagnostics');
  lines.push('');
  lines.push(`Generated ${report.t}`);
  lines.push('');
  lines.push(
    `**${report.counts.ok} ok · ${report.counts.warn} warn · ${report.counts.fail} fail · ${report.counts.skip} skip**`,
  );
  for (const sec of report.sections) {
    lines.push('');
    lines.push(`### ${sec.name}`);
    lines.push('');
    lines.push('| Status | Check | Detail |');
    lines.push('| --- | --- | --- |');
    for (const f of sec.findings) {
      const detail = [f.detail, f.hint].filter((x): x is string => Boolean(x)).map(esc).join(' — ');
      lines.push(`| ${f.status} | ${esc(f.label)} | ${detail} |`);
    }
  }
  if (review?.available) {
    lines.push('');
    lines.push('## Buddy review');
    lines.push('');
    if (review.overall) lines.push(`**Overall: ${review.overall}**`);
    lines.push('');
    if (review.summary) lines.push(review.summary);
    if (review.priorities && review.priorities.length > 0) {
      lines.push('');
      lines.push('### Priorities');
      for (const p of review.priorities) {
        lines.push(`- **[${p.severity}] ${p.title}** — ${p.why} _Fix:_ ${p.suggestedFix}`);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}
