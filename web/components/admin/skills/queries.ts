'use client';

import type { QueryClient } from '@tanstack/react-query';
import { adminJson, type AdminFetch } from '@/lib/admin-query';
import { useAdminQuery } from '@/lib/admin-query';
import type { Skill } from './shared';
import { settingsKeys } from '../settings/queries';
import { showKeys, showSkillsOf } from '../shows/queries';

export interface CommunitySkill {
  slug: string;
  label: string;
  brief: string;
  cooldown?: string;
  cohosts?: boolean;
  window?: 'any' | 'commute';
  context?: string;
  submittedBy?: string;
  dateAdded?: string;
  dateModified?: string;
  installed?: boolean;
  reserved?: boolean;
}

export interface SkillLike {
  name: string;
  kind?: string;
  label?: string;
  custom?: boolean;
  enabled?: boolean;
  cooldownMs?: number;
  cohosts?: boolean;
}

export interface SkillConfigField {
  key: string;
  type: 'text' | 'url' | 'number';
  label: string;
  placeholder?: string;
  hint?: string;
  min?: number;
  max?: number;
  integer?: boolean;
}

export interface SkillDefaults {
  label?: string;
  cooldown?: string;
  context?: string;
  cohosts?: boolean;
  brief?: string;
}

export interface SkillFileResponse {
  kind: string;
  custom?: boolean;
  configFields?: SkillConfigField[];
  config?: Record<string, string | number>;
  label?: string;
  cooldown?: string;
  cron?: string | null;
  cronInvalid?: boolean;
  cronOnly?: boolean;
  cohosts?: boolean;
  context?: string;
  knownContextFields?: string[];
  window?: 'any' | 'commute';
  requiresKey?: string;
  hasTool?: boolean;
  tags?: string[];
  brief?: string;
  defaults?: SkillDefaults | null;
  error?: string;
}

export interface SkillsResponse {
  skills?: Skill[];
  error?: string;
}

export const skillKeys = {
  all: ['skills'] as const,
  installed: () => ['skills', 'installed'] as const,
  community: () => ['skills', 'community'] as const,
  roster: () => settingsKeys.detail(),
  files: () => ['skills', 'file'] as const,
  file: (id: string) => ['skills', 'file', id] as const,
};

export function installedSkillsOf(response: SkillsResponse): Skill[] {
  return Array.isArray(response.skills) ? response.skills : [];
}

export function writeInstalledSkills(client: QueryClient, response: SkillsResponse): void {
  if (!Array.isArray(response.skills)) {
    void client.invalidateQueries({ queryKey: skillKeys.installed(), exact: true });
    void client.invalidateQueries({ queryKey: showKeys.skills(), exact: true });
    return;
  }
  client.setQueryData(skillKeys.installed(), response.skills);
  client.setQueryData(showKeys.skills(), showSkillsOf(response.skills));
}

export function useInstalledSkillsQuery(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<Skill[]>({
    key: skillKeys.installed(),
    adminFetch,
    enabled,
    request: async (fetcher, signal) => installedSkillsOf(
      await adminJson<SkillsResponse>(fetcher, '/dj/skills', undefined, signal),
    ),
    toastOnError: false,
  });
}

export function useCommunitySkillsQuery(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<CommunitySkill[]>({
    key: skillKeys.community(),
    adminFetch,
    enabled,
    request: async (fetcher, signal) => {
      const response = await adminJson<{ community?: CommunitySkill[] }>(
        fetcher, '/dj/skills/community', undefined, signal,
      );
      return Array.isArray(response.community) ? response.community : [];
    },
    toastOnError: false,
  });
}

export function useSkillFileQuery(adminFetch: AdminFetch, id: string, enabled: boolean) {
  return useAdminQuery<SkillFileResponse>({
    key: skillKeys.file(id),
    adminFetch,
    enabled: enabled && Boolean(id),
    request: (fetcher, signal) => adminJson<SkillFileResponse>(
      fetcher, `/dj/skills/${encodeURIComponent(id)}/file`, undefined, signal,
    ),
    toastOnError: false,
  });
}
