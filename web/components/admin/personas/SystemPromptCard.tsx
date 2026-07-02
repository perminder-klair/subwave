'use client';
// The global system-prompt editor — one template shared by every persona.
// Toggled from the hero.
import type { ChangeEvent } from 'react';
import { Card, Btn, Seg } from '../ui';
import { Textarea } from '../../ui/textarea';
import { cn } from '../../../lib/cn';
import { PROMPT_MIN, PROMPT_MAX } from './constants';

interface SystemPromptCardProps {
  useCustomPrompt: boolean;
  systemPrompt: string;
  defaultPrompt: string;
  promptOk: boolean;
  promptText: string;   // trimmed
  busy: boolean;
  // Save is shared with the persona editor — both POST the whole form (personas
  // + djPrompt) — so `canSave` carries the same roster-wide gate. When it's
  // blocked by something other than the prompt, `allPersonasOk` lets us say why.
  canSave: boolean;
  allPersonasOk: boolean;
  onSetUseCustom: (custom: boolean) => void;
  onChangePrompt: (text: string) => void;
  onRestore: () => void;
  onSave: () => void;
  onDiscard: () => void;
}

export function SystemPromptCard({
  useCustomPrompt, systemPrompt, defaultPrompt, promptOk, promptText, busy,
  canSave, allPersonasOk,
  onSetUseCustom, onChangePrompt, onRestore, onSave, onDiscard,
}: SystemPromptCardProps) {
  return (
    <Card title="System prompt" sub="shared by every persona">
      <p className="mb-2.5 max-w-[70ch] text-[12px] leading-[1.6] text-muted">
        One template wrapped around every DJ generation, shared by all personas.
        Placeholders: <code>{'{name}'}</code> · <code>{'{soul}'}</code> ·{' '}
        <code>{'{station}'}</code> · <code>{'{location}'}</code> · <code>{'{language}'}</code>.
        Most stations never touch this.
      </p>
      <Seg
        value={useCustomPrompt ? 'custom' : 'default'}
        options={[{ id: 'default', label: 'Built-in default' }, { id: 'custom', label: 'Custom' }]}
        onChange={v => onSetUseCustom(v === 'custom')}
      />
      {!useCustomPrompt ? (
        <div className="mt-3">
          <div className="caption mb-1.5">the DJ uses this built-in template</div>
          <pre className="term max-h-[220px]">
            {defaultPrompt || '(default unavailable)'}
          </pre>
        </div>
      ) : (
        <div className="mt-3">
          <Textarea
            rows={12}
            value={systemPrompt}
            maxLength={PROMPT_MAX}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChangePrompt(e.target.value)}
            className={cn(
              'font-mono text-[12px]',
              promptOk ? 'border-ink' : 'border-[var(--danger)]',
            )}
          />
          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            <Btn onClick={onRestore} disabled={busy || !defaultPrompt}>
              Restore default text
            </Btn>
            <span className={cn('caption', promptOk ? 'text-muted' : 'text-[var(--danger)]')}>
              {promptText.length}/{PROMPT_MAX} chars
              {!promptText.includes('{name}') && ' · missing {name}'}
              {promptText.length > 0 && promptText.length < PROMPT_MIN && ` · min ${PROMPT_MIN}`}
            </span>
          </div>
        </div>
      )}

      {/* Save bar. Lives on the card itself because the persona editor — the
          only other place this form can be saved from — is a modal that's
          closed while you're editing the prompt (issue #724). */}
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-ink pt-3">
        <span
          className={cn(
            'size-1.5 flex-none rounded-full',
            canSave ? 'bg-[var(--accent)]' : 'bg-[var(--danger)]',
          )}
        />
        <span className="text-[11px] text-muted">
          {!canSave && !promptOk
            ? <span className="text-[var(--danger)]">fix the custom system prompt</span>
            : !canSave && !allPersonasOk
              ? <span className="text-[var(--danger)]">a persona in the roster is incomplete — fix it before saving</span>
              : 'changes apply on the next spoken line · no mixer restart'}
        </span>
        <span className="ml-auto flex items-center gap-3">
          <Btn onClick={onDiscard} disabled={busy}>Discard</Btn>
          <Btn tone="accent" onClick={onSave} disabled={busy || !canSave}>
            {busy ? 'Saving…' : 'Save system prompt'}
          </Btn>
        </span>
      </div>
    </Card>
  );
}
