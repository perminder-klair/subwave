'use client';

// One music source's settings, drawn from its plugin manifest — so a plugin
// someone else wrote gets a working form with no web changes. Shared by
// admin Settings → Music source and the onboarding wizard.

import type { ChangeEvent } from 'react';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';
import { Toggle } from '../ui';
import type { MusicConfigField, MusicPluginInfo } from '../../../lib/schemas.generated';
import type { ConfigValue, DraftSource } from './sourceDraft';

// Utilities rather than the admin's .field / .field-hint helpers, which are
// scoped to .admin-root: the onboarding wizard renders this form too.
const FIELD = 'flex flex-col gap-1.5';
const HINT = 'font-mono text-[12px] leading-[1.2] text-muted';

interface SourceFieldsProps {
  plugin: MusicPluginInfo;
  source: DraftSource;
  onChange: (config: Record<string, ConfigValue>) => void;
  /** Prefix for input ids, so two editors on one page do not collide. */
  idPrefix: string;
}

export function SourceFields({ plugin, source, onChange, idPrefix }: SourceFieldsProps) {
  if (!plugin.config.length) {
    return <div className={HINT}>This source has no settings.</div>;
  }
  const set = (key: string, value: ConfigValue) => onChange({ ...source.config, [key]: value });
  return (
    <div className="grid gap-[18px]">
      {plugin.config.map((field) => (
        <Field
          key={field.key}
          field={field}
          id={`${idPrefix}-${field.key}`}
          value={source.config[field.key]}
          locked={plugin.envLocked.includes(field.key)}
          stored={field.type === 'secret' && source.secretsSet.includes(field.key)}
          onChange={(v) => set(field.key, v)}
        />
      ))}
    </div>
  );
}

interface FieldProps {
  field: MusicConfigField;
  id: string;
  value: ConfigValue | undefined;
  locked: boolean;
  stored: boolean;
  onChange: (value: ConfigValue) => void;
}

function Field({ field, id, value, locked, stored, onChange }: FieldProps) {
  const label = `${field.label}${field.required ? '' : ' (optional)'}`;
  const hint = locked ? (
    <div className={HINT}>
      Set via <code>{field.env}</code> in the root <code>.env</code> — env always wins; remove it there to manage it here.
    </div>
  ) : field.help ? (
    <div className={HINT}>{field.help}</div>
  ) : null;

  if (field.type === 'boolean') {
    const on = value === undefined || value === null ? field.default === true : value === true;
    return (
      <div className={FIELD}>
        <div className="flex items-center gap-3">
          <Toggle on={on} disabled={locked} onClick={() => onChange(!on)} ariaLabel={field.label} />
          <span className="text-[13px]">{field.label}</span>
        </div>
        {hint}
      </div>
    );
  }

  if (field.type === 'select') {
    const current = typeof value === 'string' ? value : typeof field.default === 'string' ? field.default : '';
    return (
      <div className={FIELD}>
        <Label htmlFor={id}>{label}</Label>
        <Select value={current} disabled={locked} onValueChange={(v: string) => onChange(v)}>
          <SelectTrigger id={id} className="w-[280px] max-w-full" aria-label={field.label}>
            <SelectValue placeholder="Choose…" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {(field.options ?? []).map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {hint}
      </div>
    );
  }

  const secret = field.type === 'secret';
  const text = value === null || value === undefined ? '' : String(value);
  return (
    <div className={FIELD}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={secret ? 'password' : field.type === 'number' ? 'number' : 'text'}
        autoComplete="off"
        value={text}
        disabled={locked}
        placeholder={secret && stored ? '•••••• (on file)' : field.placeholder ?? ''}
        onChange={(ev: ChangeEvent<HTMLInputElement>) => {
          const raw = ev.target.value;
          onChange(field.type === 'number' ? (raw.trim() === '' ? null : Number(raw)) : raw);
        }}
        className={field.type === 'url' ? 'max-w-[420px]' : 'max-w-[280px]'}
      />
      {hint ?? (secret ? (
        <div className={HINT}>
          Write-only — the saved value never leaves the server.{stored ? ' Leave blank to keep the one on file.' : ''}
        </div>
      ) : null)}
    </div>
  );
}
