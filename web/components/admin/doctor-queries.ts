'use client';

import type { QueryClient } from '@tanstack/react-query';
import { adminJson, adminResponse, type AdminFetch } from '@/lib/admin-query';
import { useAdminMutation, useAdminQuery } from '@/lib/admin-query';

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skip';
export type DoctorFixId = 'refresh-playlist' | 'restart-mixer' | 'generate-jingles' | 'tag-library' | 'subsonic-reset';

export interface DoctorFixAction {
  id: DoctorFixId;
  label: string;
}

export interface DoctorFinding {
  label: string;
  status: DoctorStatus;
  detail?: string;
  hint?: string;
  fix?: DoctorFixAction;
}

export interface DoctorSection {
  name: string;
  findings: DoctorFinding[];
}

export interface DoctorReport {
  t: string;
  sections: DoctorSection[];
  counts: { ok: number; warn: number; fail: number; skip: number };
}

export interface DoctorReviewPriority {
  title: string;
  severity: 'low' | 'med' | 'high';
  why: string;
  suggestedFix: string;
  fixId?: DoctorFixId | null;
}

export interface DoctorReview {
  available: boolean;
  reason?: string;
  overall?: 'healthy' | 'attention' | 'critical';
  summary?: string;
  priorities?: DoctorReviewPriority[];
}

export interface DoctorLast {
  report: DoctorReport | null;
  review: DoctorReview | null;
}

export const doctorKeys = {
  all: ['doctor'] as const,
  last: () => ['doctor', 'last'] as const,
};

export function finishReport(
  client: QueryClient,
  report: DoctorReport,
  review: DoctorReview | null,
): void {
  client.setQueryData<DoctorLast>(doctorKeys.last(), { report, review });
}

export function useDoctorLastQuery(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<DoctorLast>({
    key: doctorKeys.last(),
    adminFetch,
    enabled,
    request: async (fetcher, signal) => {
      const response = await adminJson<Partial<DoctorLast>>(
        fetcher, '/doctor/last', undefined, signal,
      );
      return { report: response.report ?? null, review: response.review ?? null };
    },
    toastOnError: false,
  });
}

export function useDoctorReviewMutation(adminFetch: AdminFetch) {
  return useAdminMutation<DoctorReview, DoctorReport>({
    adminFetch,
    request: (report, fetcher) => adminJson<DoctorReview>(fetcher, '/doctor/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report }),
    }),
    onDone: (review, report, client) => finishReport(client, report, review),
    toastOnError: false,
  });
}

export function useDoctorFixMutation(adminFetch: AdminFetch) {
  return useAdminMutation<void, { id: DoctorFixId; path: string }>({
    adminFetch,
    request: async ({ path }, fetcher) => {
      await adminResponse(fetcher, path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    },
    onDone: async (_data, _vars, client) => {
      await client.invalidateQueries({ queryKey: doctorKeys.last(), exact: true, refetchType: 'none' });
    },
    toastOnError: false,
  });
}
