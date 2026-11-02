'use client';

// What num_ctx this station's prompts need, shown under the field it sizes.
// Measured by the controller from the input tokens each call reported since it
// started (/stats `llm.contextWindows`), so it firms up as the station runs.
// "Use" fills the field; the section's Save still writes it.

import { adminJson, useAdminQuery, type AdminFetch } from '../../../lib/admin-query';
import { cn } from '../../../lib/cn';
import { Btn } from '../ui';
import { statsKeys } from '../stats-queries';
import { fmtInt, fmtTokens, kindName } from '../stats/format';
import type { ContextWindow, StatsResponse } from '../stats/types';

// Ollama's own default when num_ctx is 0.
const OLLAMA_DEFAULT_CTX = 4096;

export function ContextSizing({ adminFetch, numCtx, onUse }: {
  adminFetch: AdminFetch;
  numCtx: number;
  onUse: (tokens: number) => void;
}) {
  const query = useAdminQuery<StatsResponse>({
    key: statsKeys.rollups(), adminFetch,
    request: (fetcher, signal) => adminJson(fetcher, '/stats', undefined, signal),
  });
  const ctx = query.data?.llm?.contextWindows;
  // Loading, failed, or a controller too old to measure: the field's own hint stands.
  if (!ctx) return null;

  const route = query.data?.trackSelection === 'shortlist' ? 'shortlist' : 'agentic';
  const active = route === 'shortlist' ? ctx.shortlist : ctx.agenticPicker;
  const need = active?.suggestedTokens ?? null;
  const current = numCtx || OLLAMA_DEFAULT_CTX;
  const short = need != null && current < need;
  const routes: { id: string; label: string; w: ContextWindow | undefined }[] = [
    { id: 'agentic', label: 'Agentic picker', w: ctx.agenticPicker },
    { id: 'shortlist', label: 'Track shortlist', w: ctx.shortlist },
  ];

  return (
    <div className="mt-3 grid max-w-[640px] gap-3 border border-separator-strong p-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="caption">What this station needs</span>
        <span className="field-hint">from prompt sizes since the controller started</span>
      </div>

      {need != null ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="mono-num text-[22px] leading-none font-bold text-vermilion">{fmtTokens(need)}</span>
          <span className="field-hint">
            for the {route} route this station runs
            {/* Its own span: .field-hint's colour outranks a utility on the same node. */}
            {short && (
              <span className="text-vermilion">
                {` · the ${numCtx ? fmtInt(numCtx) : 'Ollama default of 4,096'} set here is too small`}
              </span>
            )}
          </span>
          {numCtx !== need && (
            <Btn sm onClick={() => onUse(need)}>Use {fmtInt(need)}</Btn>
          )}
        </div>
      ) : (
        <span className="field-hint italic">{active?.message || 'Waiting for calls that report their input tokens.'}</span>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] border-collapse text-[12px]">
          <thead>
            <tr className="caption border-b border-separator-strong text-left">
              <th className="py-1 font-medium">route</th>
              <th className="py-1 text-right font-medium">num_ctx</th>
              <th className="py-1 pl-3 font-medium">peak prompt</th>
              <th className="py-1 text-right font-medium">headroom</th>
              <th className="py-1 text-right font-medium">samples</th>
            </tr>
          </thead>
          <tbody>
            {routes.map(r => (
              <tr key={r.id} className={cn('border-b border-separator-soft', r.id === route && 'font-semibold')}>
                <td className="py-1.5">{r.label}{r.id === route ? ' · in use' : ''}</td>
                <td className="mono-num py-1.5 text-right">{fmtTokens(r.w?.suggestedTokens)}</td>
                <td className="mono-num py-1.5 pl-3 text-muted">
                  {r.w?.peakInputTokens != null
                    ? `${fmtTokens(r.w.peakInputTokens)}${r.w.peakKind ? ` · ${kindName(r.w.peakKind)}` : ''}`
                    : '—'}
                </td>
                <td className="mono-num py-1.5 text-right">
                  {r.w?.headroomPct != null ? `${r.w.headroomPct}% + ${fmtTokens(r.w.responseReserveTokens)}` : '—'}
                </td>
                <td className="mono-num py-1.5 text-right">{fmtInt(r.w?.samples)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="field-hint m-0">
        num_ctx is one setting for every call, so each route&apos;s figure has to fit its own picker prompts plus
        every other model call running beside it (links, segments, requests). The agentic route counts its largest
        single model step, not the whole tool loop. Both add headroom and a response reserve, then round up.
      </p>

      {ctx.byKind.length > 0 && (
        <details className="group">
          <summary className="caption cursor-pointer select-none">Per function</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[420px] border-collapse text-[12px]">
              <thead>
                <tr className="caption border-b border-separator-strong text-left">
                  <th className="py-1 font-medium">function</th>
                  <th className="py-1 text-right font-medium">calls</th>
                  <th className="py-1 text-right font-medium">usage</th>
                  <th className="py-1 text-right font-medium">avg context</th>
                  <th className="py-1 text-right font-medium">peak</th>
                </tr>
              </thead>
              <tbody>
                {ctx.byKind.map(k => (
                  <tr key={k.kind} className="border-b border-separator-soft">
                    <td className="py-1.5" title={k.kind}>{kindName(k.kind)}</td>
                    <td className="mono-num py-1.5 text-right">{fmtInt(k.calls)}</td>
                    <td className="mono-num py-1.5 text-right">{k.samples}/{k.calls}</td>
                    <td className="mono-num py-1.5 text-right">{fmtTokens(k.averageInputTokens)}</td>
                    <td className="mono-num py-1.5 text-right">{fmtTokens(k.peakInputTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
