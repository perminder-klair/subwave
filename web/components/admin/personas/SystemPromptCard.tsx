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
  onSetUseCustom: (custom: boolean) => void;
  onChangePrompt: (text: string) => void;
  onRestore: () => void;
}

export function SystemPromptCard({
  useCustomPrompt, systemPrompt, defaultPrompt, promptOk, promptText, busy,
  onSetUseCustom, onChangePrompt, onRestore,
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
    </Card>
  );
}
