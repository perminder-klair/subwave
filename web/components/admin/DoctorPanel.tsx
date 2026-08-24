'use client';

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCopyToClipboard } from 'usehooks-ts';
import { useAdminAuth } from '../../lib/adminAuth';
import { notify, errorMessage } from '../../lib/notify';
import { Card, Btn, Pill } from './ui';
import { ErrorState } from '@/components/ui/error-state';
import BoothBuddy, { type BuddyMood } from '../BoothBuddy';
import { ChevronDownIcon } from 'lucide-react';
import { Task, TaskContent, TaskItem, TaskTrigger } from '../ai-elements/task';
import { Shimmer } from '../ai-elements/shimmer';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '../ai-elements/reasoning';
import { MessageResponse } from '../ai-elements/message';
import { adminResponse } from '../../lib/admin-query';
import {
  doctorKeys,
  finishReport,
  useDoctorFixMutation,
  useDoctorLastQuery,
  useDoctorReviewMutation,
  type DoctorFixAction,
  type DoctorFixId,
  type DoctorLast,
  type DoctorReport,
  type DoctorReview,
  type DoctorSection,
  type DoctorStatus,
} from './doctor-queries';

// Shapes mirror controller/src/doctor.ts.

// All are admin-gated POSTs that accept an empty body.
const FIX_ENDPOINTS: Record<DoctorFixId, string> = {
  'refresh-playlist': '/dj/refresh-playlist',
  'restart-mixer': '/restart-mixer',
  'generate-jingles': '/onboarding/generate-jingles',
  'tag-library': '/tag-library',
  'subsonic-reset': '/debug/subsonic/reset',
};

const MOOD_BY_OVERALL: Record<NonNullable<DoctorReview['overall']>, BuddyMood> = {
  healthy: 'content',
  attention: 'curious',
  critical: 'spooked',
};

// Deliberately the upstream project repo, not a per-station setting: bug
// reports are about the software itself.
const HQ_ISSUES_NEW = 'https://github.com/perminder-klair/subwave/issues/new';
// GitHub's prefilled-issue form is a GET, and past ~8KB the request 414s or
// silently truncates — stay well under and fall back to the clipboard.
const HQ_URL_LIMIT = 7000;

// Mirrors SECTION_CHECKS in controller/src/doctor.ts. Only the in-flight
// shimmer rows key off it, so drift just shimmers the wrong names for a few
// seconds; the finished report renders whatever actually arrived.
const EXPECTED_SECTIONS = [
  'LLM',
  'Navidrome & library',
  'Broadcast',
  'Voice (TTS)',
  'Capabilities',
  'Content',
  'Resources',
  'Tuning',
  'Storage',
  'Setup',
];

function tallyCounts(sections: DoctorSection[]): DoctorReport['counts'] {
  const c = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const s of sections) for (const f of s.findings) c[f.status]++;
  return c;
}

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
  const queryClient = useQueryClient();
  const [, copyToClipboard] = useCopyToClipboard();
  const [running, setRunning] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [busyFix, setBusyFix] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const ready = hydrated && !needsAuth;
  const lastQuery = useDoctorLastQuery(adminFetch, ready);
  const reviewMutation = useDoctorReviewMutation(adminFetch);
  const fixMutation = useDoctorFixMutation(adminFetch);
  const cached = lastQuery.data ?? { report: null, review: null };
  const [inFlightReport, setInFlightReport] = useState<DoctorReport | null>(null);
  const report = inFlightReport ?? cached.report;
  const review = cached.review;
  // Suppresses the intro hero flashing before a cached report loads in.
  const hydrating = lastQuery.isPending;

  // Fix actions present in the current report. A fixId not in this map is never
  // surfaced as a button.
  const fixById = useMemo(() => {
    const m = new Map<DoctorFixId, DoctorFixAction>();
    report?.sections.forEach((s) =>
      s.findings.forEach((f) => {
        if (f.fix && !m.has(f.fix.id)) m.set(f.fix.id, f.fix);
      }),
    );
    return m;
  }, [report]);

  // Sections the live run hasn't delivered yet, painted as in-flight rows.
  const pendingSections =
    running && report
      ? EXPECTED_SECTIONS.filter((n) => !report.sections.some((s) => s.name === n))
      : [];

  // One-shot batch run — the fallback when SSE streaming isn't available.
  const runBatch = async (): Promise<DoctorReport | null> => {
    // admin-query-imperative: diagnosis-command
    const r = await adminResponse(adminFetch, '/doctor');
    const j = (await r.json().catch(() => null)) as DoctorReport | { error?: string } | null;
    if (!j || !('sections' in j)) {
      throw new Error((j as { error?: string })?.error || 'doctor returned no report');
    }
    finishReport(queryClient, j, null);
    setInFlightReport(null);
    return j;
  };

  const run = async (): Promise<DoctorReport | null> => {
    setRunning(true);
    setErr(null);
    // A fresh run invalidates the previous review (it described the old report).
    queryClient.setQueryData<DoctorLast>(doctorKeys.last(), previous => ({
      report: previous?.report ?? null,
      review: null,
    }));
    try {
      // admin-query-imperative: diagnosis-stream
      const r = await adminResponse(adminFetch, '/doctor/stream', {
        headers: { Accept: 'text/event-stream' },
      });
      if (!r.body) throw new Error('stream unavailable (empty body)');
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const sections: DoctorSection[] = [];
      let final: DoctorReport | null = null;
      // Empty shell first so the intro hero yields to the progressive report.
      setInFlightReport({ t: new Date().toISOString(), sections: [], counts: tallyCounts([]) });
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
            setInFlightReport({ t: new Date().toISOString(), sections: [...sections], counts: tallyCounts(sections) });
          } else if (event === 'done' && data) {
            final = data as DoctorReport;
            setInFlightReport(final);
          } else if (event === 'error') {
            throw new Error((data as { error?: string })?.error || 'doctor failed');
          }
        }
      }
      if (!final) {
        if (!sections.length) throw new Error('doctor stream ended before completion');
        const partial = {
          t: new Date().toISOString(),
          sections,
          counts: tallyCounts(sections),
        };
        finishReport(queryClient, partial, null);
        setInFlightReport(null);
        return partial;
      }
      finishReport(queryClient, final, null);
      setInFlightReport(null);
      return final;
    } catch {
      // Streaming failed (proxy, older controller, aborted body).
      try {
        return await runBatch();
      } catch (e2) {
        setInFlightReport(null);
        setErr(errorMessage(e2));
        return null;
      }
    } finally {
      setRunning(false);
    }
  };

  // `rep` is passed in by the "Let's go" chain: run()'s setState isn't visible
  // in the same tick, so reading `report` from the closure would be stale.
  const askReview = async (rep?: DoctorReport) => {
    const target = rep ?? report;
    if (!target) return;
    setReviewing(true);
    try {
      const nextReview = await reviewMutation.mutateAsync(target);
      if (!nextReview.available) {
        notify.info(nextReview.reason || 'review unavailable');
      }
    } catch (e) {
      notify.err(`buddy review: ${errorMessage(e)}`);
    } finally {
      setReviewing(false);
    }
  };

  const letsGo = async () => {
    const rep = await run();
    if (rep) await askReview(rep);
  };

  const runFix = async (fix: DoctorFixAction) => {
    setBusyFix(fix.id);
    try {
      await fixMutation.mutateAsync({ id: fix.id, path: FIX_ENDPOINTS[fix.id] });
      notify.ok(`${fix.label} done`);
      await run(); // re-assess so the finding clears (or shows what's left)
    } catch (e) {
      notify.err(`${fix.label}: ${errorMessage(e)}`);
    } finally {
      setBusyFix(null);
    }
  };

  // The browser's own reason (NotAllowedError and friends) isn't actionable to
  // an operator and useCopyToClipboard console.warns it for anyone debugging,
  // so the toast just reports the failure.
  const copyMarkdown = async () => {
    if (!report) return;
    if (await copyToClipboard(toMarkdown(report, review))) {
      notify.ok('report copied — paste into a GitHub issue');
    } else {
      notify.err('copy failed — the browser blocked clipboard access');
    }
  };

  // Only opens the form — nothing is filed until the operator submits on GitHub.
  const sendToHQ = async () => {
    if (!report) return;
    const title = `Station diagnostics — ${report.counts.fail} fail · ${report.counts.warn} warn · ${report.counts.skip} skip`;
    const body = `_Filed from DJ Doc (Admin → DJ Doc → station health)._\n\n${toMarkdown(report, review)}`;
    const full = `${HQ_ISSUES_NEW}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    // Too long to ride in the URL — copy it and prefill a pointer instead.
    if (full.length > HQ_URL_LIMIT) {
      // Clipboard may be blocked; the short form still opens either way.
      await copyToClipboard(body);
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
              {err && <ErrorState error={err} onRetry={run} />}
            </div>
          </div>
        </Card>
      )}

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
              {err && <ErrorState error={err} onRetry={run} />}
            </div>
          </div>
        </Card>
      )}

      {/* The animated indicator carries the 20–60s LLM call: a button-label
          change alone read as stalled. */}
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
                <div className="mt-4 flex flex-col gap-1.5" aria-hidden="true">
                  <Shimmer className="text-[13px] leading-[1.55]" duration={2}>
                    Spinning the report back like a rough mix…
                  </Shimmer>
                  <Shimmer className="text-[13px] leading-[1.55]" duration={2.4}>
                    Listening for mud in the low end…
                  </Shimmer>
                  <Shimmer className="text-[13px] leading-[1.55]" duration={2.8}>
                    Writing the verdict up straight. No fluff.
                  </Shimmer>
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
                {/* The LLM may hand back markdown — render it, don't print it. */}
                {review.summary && (
                  <MessageResponse className="text-[15px] leading-[1.65]">{review.summary}</MessageResponse>
                )}
                {review.priorities && review.priorities.length > 0 && (
                  <ul className="mt-4 flex flex-col gap-3">
                    {review.priorities.map((p, i) => {
                      // Only offer the button when the tagged fix exists here.
                      const fix = p.fixId ? fixById.get(p.fixId) : undefined;
                      return (
                        <li key={i} className="border-l-2 border-[color:var(--separator-strong)] pl-3">
                          <div className="flex flex-wrap items-center gap-2">
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
                            {fix && (
                              <span className="ml-auto">
                                <Btn sm onClick={() => runFix(fix)} disabled={busyFix === fix.id}>
                                  {busyFix === fix.id ? '…' : fix.label}
                                </Btn>
                              </span>
                            )}
                          </div>
                          <Reasoning defaultOpen={false} className="mt-1.5 mb-0">
                            <ReasoningTrigger className="group w-fit cursor-pointer text-[10px] font-bold tracking-[0.18em] text-muted uppercase hover:text-ink">
                              <span>The why &amp; the fix</span>
                              <ChevronDownIcon
                                className="size-3.5 transition-transform group-data-[state=open]:rotate-180"
                                aria-hidden="true"
                              />
                            </ReasoningTrigger>
                            <ReasoningContent className="mt-2 text-[13px] leading-[1.55]">
                              {`${p.why}\n\n**Fix:** ${p.suggestedFix}`}
                            </ReasoningContent>
                          </Reasoning>
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

      {report && (report.sections.length > 0 || running) && (
        <Card className="mt-6" title="The rundown" sub={running ? 'running the levels…' : 'section by section'}>
          <div className="flex flex-col divide-y divide-[color:var(--separator-strong)]">
            {report.sections.map((sec) => {
              const fails = sec.findings.filter((f) => f.status === 'fail').length;
              const warns = sec.findings.filter((f) => f.status === 'warn').length;
              return (
                <Task key={sec.name} defaultOpen className="py-2.5 first:pt-0 last:pb-0">
                  <TaskTrigger title={sec.name}>
                    <div className="flex w-full cursor-pointer items-center gap-2">
                      <span className="text-[11px] font-bold tracking-[0.18em] text-ink uppercase">{sec.name}</span>
                      {fails > 0 && (
                        <Pill tone="accent" className="border-[var(--accent)] bg-[var(--accent)] text-white">
                          {fails} fail
                        </Pill>
                      )}
                      {warns > 0 && <Pill tone="accent">{warns} warn</Pill>}
                      <ChevronDownIcon
                        className="ml-auto size-3.5 text-muted transition-transform group-data-[state=open]:rotate-180"
                        aria-hidden="true"
                      />
                    </div>
                  </TaskTrigger>
                  <TaskContent>
                    {sec.findings.map((f, i) => (
                      <TaskItem
                        key={`${sec.name}-${f.label}-${i}`}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[14px] text-ink"
                      >
                        <StatusPill status={f.status} />
                        <span className="font-bold">{f.label}</span>
                        {/* Machine values (model ids, paths, URLs) have no break
                            opportunity — wrap them or they run past the card edge. */}
                        {f.detail && (
                          <span className="min-w-0 font-mono text-[12px] break-words text-muted">{f.detail}</span>
                        )}
                        {f.fix && (
                          <span className="ml-auto">
                            <Btn sm onClick={() => runFix(f.fix as DoctorFixAction)} disabled={busyFix === f.fix.id}>
                              {busyFix === f.fix.id ? '…' : f.fix.label}
                            </Btn>
                          </span>
                        )}
                        {f.hint && <p className="w-full text-[12px] leading-[1.5] break-words text-muted">{f.hint}</p>}
                      </TaskItem>
                    ))}
                  </TaskContent>
                </Task>
              );
            })}
            {pendingSections.map((name, i) => (
              <div key={name} className="flex items-center py-2.5 last:pb-0">
                <Shimmer
                  as="span"
                  duration={1.6}
                  className="text-[11px] font-bold tracking-[0.18em] uppercase"
                >
                  {i === 0 ? `${name} — on the meter now…` : name}
                </Shimmer>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: DoctorStatus }) {
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
