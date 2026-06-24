'use client';

// Doctor — /admin/doctor. Runs the controller-side health assessment, offers a
// one-click fix where a safe action exists, asks the buddy (the LLM) to review
// the report in plain English, and copies the whole thing as GitHub-ready
// Markdown. Mirrors DashPanel's adminFetch + act() pattern; primitives from ./ui.
import { useState } from 'react';
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

export default function DoctorPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [review, setReview] = useState<DoctorReview | null>(null);
  const [running, setRunning] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [busyFix, setBusyFix] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const ready = hydrated && !needsAuth;

  const run = async () => {
    setRunning(true);
    setErr(null);
    // A fresh run invalidates the previous review (it described the old report).
    setReview(null);
    try {
      const r = await adminFetch('/doctor');
      const j = (await r.json().catch(() => null)) as DoctorReport | { error?: string } | null;
      if (!r.ok || !j || !('sections' in j)) {
        throw new Error((j as { error?: string })?.error || `failed (${r.status})`);
      }
      setReport(j);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  const askReview = async () => {
    if (!report) return;
    setReviewing(true);
    try {
      const r = await adminFetch('/doctor/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report }),
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

  const buddyMood: BuddyMood = review?.available && review.overall ? MOOD_BY_OVERALL[review.overall] : 'content';

  return (
    <div className="mx-auto max-w-[1100px] px-7 py-8">
      {/* Intro + controls */}
      <Card
        title="DJ Doc"
        sub="station health"
        right={
          report ? (
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
          ) : undefined
        }
      >
        <div className="flex items-start gap-4">
          <BoothBuddy mood={buddyMood} size={34} />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] leading-[1.6] text-muted">
              Run a full assessment of the station — the LLM, Navidrome &amp; library, the broadcast
              chain, voices, capabilities, content, resources and storage. Each finding suggests what
              to do; where a safe fix exists you can apply it in one click. Then let DJ Doc review the
              mix and call what to fix first.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Btn tone="solid" onClick={run} disabled={running}>
                {running ? 'Running…' : report ? 'Re-run Doctor' : 'Run Doctor'}
              </Btn>
              <Btn tone="accent" onClick={askReview} disabled={!report || reviewing}>
                {reviewing ? 'DJ Doc is listening…' : 'Ask DJ Doc to review'}
              </Btn>
              <Btn onClick={copyMarkdown} disabled={!report}>
                Copy report as Markdown
              </Btn>
              {report && (
                <span className="font-mono text-[11px] text-muted">
                  last run {new Date(report.t).toLocaleTimeString()}
                </span>
              )}
            </div>
            {err && <p className="mt-3 text-[13px] text-[var(--accent)]">{err}</p>}
            {!report && !running && !ready && (
              <p className="mt-3 text-[13px] text-muted">Sign in to run the Doctor.</p>
            )}
          </div>
        </div>
      </Card>

      {/* Empty state — DJ Doc introduces himself before the first run. */}
      {ready && !report && !running && (
        <Card className="mt-6" title="Station health" sub="booth's open">
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
                Hit <span className="font-bold">Run Doctor</span> and I&apos;ll run the levels on all of it —
                then tell you straight what&apos;s clean, what&apos;s muddy, and the one thing to fix first. No fluff.
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Buddy review */}
      {review && (
        <Card
          className="mt-6"
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
                    {review.priorities.map((p, i) => (
                      <li key={i} className="border-l-2 border-[color:var(--separator-strong)] pl-3">
                        <div className="flex items-center gap-2">
                          <Pill
                            tone={p.severity === 'high' ? 'accent' : 'ink'}
                            className={p.severity === 'high' ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : undefined}
                          >
                            {p.severity}
                          </Pill>
                          <span className="text-[14px] font-bold">{p.title}</span>
                        </div>
                        <p className="mt-1 text-[13px] leading-[1.55] text-muted">{p.why}</p>
                        <p className="mt-1 text-[13px] leading-[1.55]">
                          <span className="font-bold">Fix:</span> {p.suggestedFix}
                        </p>
                      </li>
                    ))}
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
      )}

      {/* Findings by section */}
      {report?.sections.map((sec) => (
        <Card key={sec.name} className="mt-6" title={sec.name}>
          <ul className="flex flex-col divide-y divide-[color:var(--separator-strong)]">
            {sec.findings.map((f, i) => (
              <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 first:pt-0 last:pb-0">
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
