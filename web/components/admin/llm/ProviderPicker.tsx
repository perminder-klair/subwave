'use client';
import { cn } from '../../../lib/cn';
import {
  PROVIDER_META, groupProviders, providerStatus, type ProviderGroupView, type ProviderStatus,
} from './providerMeta';

interface ProviderPickerProps {
  value: string;
  // The server's list (SettingsResponse.llm.providers, or .embedding.providers
  // for the embedding picker), so the picker stays server-authoritative. Each
  // group keeps this order.
  providerIds: string[];
  // Names the radiogroup: "LLM provider", "Embedding provider".
  label: string;
  // SettingsResponse.env — which cloud key vars are present; drives the badge.
  env?: Record<string, unknown>;
  // false for the onboarding wizard, where there's no live env yet: cloud providers
  // then read as a neutral "needs key" instead of a red "no key".
  keyAware?: boolean;
  onChange: (id: string) => void;
  className?: string;
}

// One radiogroup, in the catalogue's groups (providerMeta.groupProviders). Local
// and vendor providers are cards, because there the choice is real. Gateways
// are one-line rows: they are near-interchangeable, and theirs is the group
// that grows. Each group renders through its own component, so a filter (over
// providerIds, before grouping) or a "N more gateways" collapse (inside
// GatewayRows) can be added later without touching the others.
export function ProviderPicker({ value, providerIds, label, env, keyAware = true, onChange, className }: ProviderPickerProps) {
  const status = (id: string) => providerStatus(id, env, keyAware);
  return (
    <div role="radiogroup" aria-label={label} className={cn('@container grid gap-4', className)}>
      {groupProviders(providerIds).map(view => (
        <div key={view.group} className="grid gap-2" data-group={view.group}>
          <GroupHeading>{view.label}</GroupHeading>
          {view.group === 'gateway'
            ? <GatewayRows view={view} value={value} status={status} onChange={onChange} />
            : <ProviderCards view={view} value={value} status={status} onChange={onChange} />}
        </div>
      ))}
    </div>
  );
}

interface GroupProps {
  view: ProviderGroupView;
  value: string;
  status: (id: string) => ProviderStatus;
  onChange: (id: string) => void;
}

function GroupHeading({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex-none text-[10px] font-bold tracking-[0.16em] text-muted uppercase">{children}</span>
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-[color:var(--separator-soft)]" />
    </div>
  );
}

// Columns from the group's own size, against the picker's width (its
// @container), so no row strands one card: two fill a row, three sit in a row
// of three, and four go two by two until the picker has room for a row of four.
// A longer group falls back to rows of three.
const CARD_COLUMNS: Record<number, string> = {
  2: 'grid-cols-2',
  3: 'grid-cols-2 @md:grid-cols-3',
  4: 'grid-cols-2 @2xl:grid-cols-4',
};
const cardColumns = (count: number) => CARD_COLUMNS[count] ?? 'grid-cols-2 @md:grid-cols-3';

function ProviderCards({ view, value, status, onChange }: GroupProps) {
  return (
    <div className={cn('grid gap-2.5', cardColumns(view.ids.length))} data-layout="cards">
      {view.ids.map(id => {
        const meta = PROVIDER_META[id];
        const active = value === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(id)}
            className={cn(
              'grid cursor-pointer content-start gap-1.5 border p-3 text-left font-[inherit]',
              optionTone(active),
            )}
          >
            <div className="flex items-center gap-1.5">
              <RadioDot active={active} />
              <OptionName active={active} className="min-w-0 break-words">{meta?.label || id}</OptionName>
            </div>
            <div className="flex items-end justify-between gap-2">
              <span className="min-w-0 text-[9px] leading-[1.4] text-muted">{meta?.blurb}</span>
              <StatusBadge status={status(id)} />
            </div>
          </button>
        );
      })}
    </div>
  );
}

function GatewayRows({ view, value, status, onChange }: GroupProps) {
  return (
    <div className="grid gap-1.5" data-layout="rows">
      {view.ids.map(id => {
        const meta = PROVIDER_META[id];
        const active = value === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(id)}
            className={cn(
              'flex min-w-0 cursor-pointer items-center gap-2 border px-3 py-2 text-left font-[inherit]',
              optionTone(active),
            )}
          >
            <RadioDot active={active} />
            <OptionName active={active} className="flex-none">{meta?.label || id}</OptionName>
            <span className="min-w-0 flex-1 truncate text-[9px] leading-[1.4] text-muted">{meta?.blurb}</span>
            <StatusBadge status={status(id)} />
          </button>
        );
      })}
    </div>
  );
}

const optionTone = (active: boolean) => active
  ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
  : 'border-ink bg-transparent hover:bg-[var(--ink-softer)]';

function RadioDot({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        'size-2 flex-none rounded-full border',
        active ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-ink bg-transparent',
      )}
    />
  );
}

function OptionName({ active, className, children }: { active: boolean; className?: string; children: string }) {
  return (
    <span
      className={cn(
        'text-[10px] font-bold tracking-[0.16em] uppercase',
        active ? 'text-vermilion' : 'text-ink',
        className,
      )}
    >
      {children}
    </span>
  );
}

function StatusBadge({ status }: { status: ProviderStatus }) {
  if (!status.label) return null;
  return (
    <span
      className={cn(
        'flex-none border px-1 py-[1px] text-[8px] font-bold tracking-[0.1em] uppercase',
        status.tone === 'warn'
          ? 'border-[var(--danger)] text-[var(--danger)]'
          : 'border-[color:var(--separator-strong)] text-muted',
      )}
    >
      {status.label}
    </span>
  );
}
