import { z } from 'zod';
import { DEFAULT_SLEEVE_NOTES_SEGMENT, sleeveNotesSegmentSchema } from '../../lib/schemas.generated';
import type { SettingsData } from './settings/shared';

export const notesSettingsSchema = z.object({
  collectionPaused: z.boolean(), researchWhenEmpty: z.boolean(), geniusEnabled: z.boolean(),
  token: z.string().trim().max(2000), clearToken: z.boolean(),
  artistClaimLimit: z.number().int().min(1).max(20),
  albumClaimLimit: z.number().int().min(1).max(20),
  prompt: z.string().max(8000), segment: sleeveNotesSegmentSchema,
});
export type NotesSettingsForm = z.infer<typeof notesSettingsSchema>;

export function notesSettingsDefaults(values?: SettingsData['values'], defaultPrompt = ''): NotesSettingsForm {
  return {
    collectionPaused: values?.djBehaviour?.sleeveNotesCollectionPaused === true,
    researchWhenEmpty: values?.djBehaviour?.sleeveNotesMaintenanceWhenEmpty === true,
    geniusEnabled: values?.sleeveNotes?.providers?.genius?.enabled ?? true,
    token: '', clearToken: false,
    artistClaimLimit: values?.sleeveNotes?.wikipedia?.artistClaimLimit ?? 20,
    albumClaimLimit: values?.sleeveNotes?.wikipedia?.albumClaimLimit ?? 5,
    prompt: values?.sleeveNotes?.wikipedia?.extractPrompt || defaultPrompt,
    segment: {...DEFAULT_SLEEVE_NOTES_SEGMENT, ...values?.sleeveNotes?.segment},
  };
}

/** Send changed controls only; an empty token field preserves the saved secret. */
export function notesSettingsPatch(draft: NotesSettingsForm, baseline: NotesSettingsForm, defaultPrompt = '') {
  const changed = (key: keyof NotesSettingsForm) => JSON.stringify(draft[key]) !== JSON.stringify(baseline[key]);
  const genius = {
    ...(changed('geniusEnabled') ? {enabled: draft.geniusEnabled} : {}),
    ...(draft.token.trim() ? {accessToken: draft.token.trim()} : draft.clearToken ? {accessToken: ''} : {}),
  };
  const wikipedia = {
    ...(changed('artistClaimLimit') ? {artistClaimLimit: draft.artistClaimLimit} : {}),
    ...(changed('albumClaimLimit') ? {albumClaimLimit: draft.albumClaimLimit} : {}),
    ...(changed('prompt') ? {extractPrompt: draft.prompt === defaultPrompt ? '' : draft.prompt} : {}),
  };
  const segment = Object.fromEntries(Object.entries(draft.segment).filter(([key,value]) =>
    JSON.stringify(value) !== JSON.stringify(baseline.segment[key as keyof typeof baseline.segment])));
  return {
    djBehaviour: {
      ...(changed('collectionPaused') ? {sleeveNotesCollectionPaused: draft.collectionPaused} : {}),
      ...(changed('researchWhenEmpty') ? {sleeveNotesMaintenanceWhenEmpty: draft.researchWhenEmpty} : {}),
    },
    sleeveNotes: {...(Object.keys(genius).length ? {providers: {genius}} : {}),
      ...(Object.keys(wikipedia).length ? {wikipedia} : {}), ...(Object.keys(segment).length ? {segment} : {})},
  };
}
