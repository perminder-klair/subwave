'use client';

import type { Control } from 'react-hook-form';
import { SelectField } from '@/lib/form-fields';
import type { AdminFetch } from '@/lib/admin-query';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/notify';
import type { Persona, Show, ShowsFormValues, SkillOption } from './types';
import { useRetryShowPreparation, useShowPreparationQuery } from './queries';

export function ShowPreparationField({
  show,
  index,
  control,
  personas,
  skills,
  adminFetch,
}: {
  show: Show;
  index: number;
  control: Control<ShowsFormValues>;
  personas: Persona[];
  skills: SkillOption[];
  adminFetch: AdminFetch;
}) {
  const preparation = useShowPreparationQuery(adminFetch, true);
  const retry = useRetryShowPreparation(adminFetch);
  const host = personas.find(persona => persona.id === show.personaId);
  const options = skills.filter(
    skill =>
      skill.name && skill.hasTool && skill.ready !== false && (!host?.skills || host.skills.includes(skill.name)),
  );
  const selected = options.some(skill => skill.name === show.preparationSkill);
  const status = preparation.data;
  const current = status && status.kind !== 'unconfigured' && status.occurrence.showId === show.id ? status : null;
  return (
    <div className="grid gap-2">
      <SelectField
        control={control}
        name={`shows.${index}.preparationSkill`}
        label="Episode preparation skill"
        emptyValue="__no_preparation__"
        options={[
          { value: '__no_preparation__', label: 'None' },
          ...options.flatMap(skill => (skill.name ? [{ value: skill.name, label: skill.label || skill.name }] : [])),
          ...(!selected && show.preparationSkill
            ? [{ value: show.preparationSkill, label: `${show.preparationSkill} (unavailable)` }]
            : []),
        ]}
        description="Run once per airing to choose a subject and gather research. An artist result also sets automatic music selection. The skill must be enabled and allowed for this host."
      />
      {show.preparationSkill && !selected && (
        <p className="text-xs text-amber-600">
          This skill is missing, disabled, not ready, has no data tool, or is unavailable to this host. Save keeps the
          reference so it can be restored.
        </p>
      )}
      {current && (
        <div className="text-xs" role="status">
          <p>
            Current episode: {current.subject || current.skill} · {current.kind}
          </p>
          {current.reason && <p className="text-amber-600">{current.reason}</p>}
          {(current.kind === 'failed' || current.kind === 'degraded') && (
            <Button type="button" size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate()}>
              {current.kind === 'degraded' ? 'Retry catalogue' : 'Retry preparation'}
            </Button>
          )}
        </div>
      )}
      {preparation.isError && (
        <div className="grid gap-2 text-xs" role="alert">
          <p className="text-amber-600">Could not read the current episode status. {errorMessage(preparation.error)}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={preparation.isFetching}
            onClick={() => void preparation.refetch()}
          >
            Retry status
          </Button>
        </div>
      )}
    </div>
  );
}
