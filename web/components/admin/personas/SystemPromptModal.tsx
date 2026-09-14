'use client';
// The global system-prompt library: templates shared by every persona, one
// active at a time ('' = the built-in default). Form data lives in the
// container; this holds only which of the two views is showing.
import type { ChangeEvent, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useFormState, useWatch, type Control, type UseFormSetValue } from 'react-hook-form';
import { Btn, Pill } from '../ui';
import { Textarea } from '../../ui/textarea';
import { Modal } from '../../ui/modal';
import { V3AlertDialog } from '../../ui/alert-dialog';
import { TextField, TextareaField } from '@/lib/form-fields';
import { cn } from '../../../lib/cn';
import type { DjPromptPreset, PersonasFormValues } from './types';
import { clientMintId } from './helpers';
import { HOUSE_RULES_MAX, PROMPT_MAX, PROMPT_NAME_MAX, PROMPT_PRESET_MAX } from './constants';

interface SystemPromptModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  control: Control<PersonasFormValues>;
  // `useFieldArray('djPrompts')`'s own `fields` — carries `_rhfKey` alongside
  // the real `id`, so a row's identity survives an add/remove without
  // reshuffling which row a still-open editor points at.
  promptFields: (DjPromptPreset & { _rhfKey: string })[];
  setValue: UseFormSetValue<PersonasFormValues>;
  onAppendPreset: (preset: DjPromptPreset) => void;
  onRemovePreset: (idx: number, id: string) => void;
  activeId: string;        // '' = built-in default
  // Station house rules — the one block appended to EVERY spoken-output
  // prompt, including the agent paths the template never reaches (#1182).
  // Plain state, not RHF — it isn't an array row and the controller validates
  // it as its own top-level settings key.
  houseRules: string;
  onHouseRulesChange: (v: string) => void;
  defaultPrompt: string;   // the built-in template text
  busy: boolean;
  // Save is shared with the persona editor (both POST the whole form), so `canSave`
  // carries the same roster-wide gate; `allPersonasOk` says when the block is
  // something other than the prompts.
  canSave: boolean;
  allPersonasOk: boolean;
  promptsOk: boolean;      // every preset in the library is valid
  onSetActive: (id: string) => void;
  onSave: () => void;
  onDiscard: () => void;
}

export function SystemPromptModal({
  open, onOpenChange, control, promptFields, setValue,
  activeId, houseRules, onHouseRulesChange, defaultPrompt,
  busy, canSave, allPersonasOk, promptsOk,
  onSetActive, onAppendPreset, onRemovePreset, onSave, onDiscard,
}: SystemPromptModalProps) {
  // null = the library list, 'default' = the read-only built-in, else a preset id.
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // The schema's own per-row verdict — not a local reimplementation of it.
  const { errors } = useFormState({ control, name: 'djPrompts' });
  // `promptFields` is the row identity list (_rhfKey, order, id) and does not
  // reflect live keystrokes written by TextField's own useController.
  // `useWatch` reads the current values from the central RHF store.
  const watchedPrompts = useWatch({ control, name: 'djPrompts' });

  // Re-opening always lands on the library list, never a stale editor.
  useEffect(() => {
    if (!open) { setEditing(null); setConfirmDeleteId(null); }
  }, [open]);

  const addPreset = () => {
    if (promptFields.length >= PROMPT_PRESET_MAX) return;
    // Seed from the built-in template rather than a blank textarea.
    const preset: DjPromptPreset = {
      id: clientMintId('dp_'),
      name: `Prompt ${promptFields.length + 1}`,
      text: defaultPrompt,
    };
    onAppendPreset(preset);
    setEditing(preset.id);
  };

  const editingIdx = editing && editing !== 'default'
    ? promptFields.findIndex(p => p.id === editing)
    : -1;
  const editingPreset = editingIdx !== -1 ? (watchedPrompts[editingIdx] ?? null) : null;
  const editingText = editingPreset ? editingPreset.text.trim() : '';
  const editingError = editingIdx !== -1 ? errors.djPrompts?.[editingIdx] : undefined;
  const deleting = confirmDeleteId ? promptFields.find(p => p.id === confirmDeleteId) : null;

  const row = (opts: {
    key: string;
    name: string;
    meta: string;
    isActive: boolean;
    invalid?: boolean;
    onUse: () => void;
    actions: ReactNode;
  }) => (
    <div
      key={opts.key}
      className={cn(
        // Phones drop the actions onto a second row: radio + name + two buttons
        // can't share a ~320px line without clipping the name.
        'grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2.5 border p-2.5',
        'sm:grid-cols-[auto_1fr_auto] sm:gap-3',
        opts.invalid ? 'border-[var(--danger)]' : opts.isActive ? 'border-ink' : 'border-ink/40',
      )}
    >
      <button
        type="button"
        aria-label={opts.isActive ? `${opts.name} is in use` : `Use ${opts.name}`}
        onClick={opts.onUse}
        disabled={opts.isActive}
        className={cn(
          'v3-focus relative grid size-4 flex-none place-items-center rounded-full border border-ink bg-transparent p-0',
          // Invisible 36px hit box on phones: the 16px dot is too small for a thumb.
          "before:absolute before:-inset-2.5 before:content-[''] sm:before:content-none",
          opts.isActive ? 'cursor-default' : 'cursor-pointer hover:border-[var(--accent)]',
        )}
      >
        {opts.isActive && <span className="size-2 rounded-full bg-[var(--accent)]" />}
      </button>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-extrabold">{opts.name}</span>
          {opts.isActive && <Pill tone="accent" dot className="flex-none text-[8px]">in use</Pill>}
          {opts.invalid && <Pill className="flex-none text-[8px] text-[var(--danger)]">incomplete</Pill>}
        </div>
        <div className="caption mt-0.5">{opts.meta}</div>
      </div>
      <div className="col-span-2 flex flex-none flex-wrap items-center justify-end gap-2 sm:col-span-1 sm:justify-start">
        {opts.actions}
      </div>
    </div>
  );

  // Full-width wrapping row rather than bare children of the modal's
  // non-wrapping footer flex, so phones can break onto two lines.
  const libraryFooter = (
    <div className="flex w-full flex-wrap items-center justify-end gap-2">
      <span
        className={cn(
          'size-1.5 flex-none rounded-full',
          canSave ? 'bg-[var(--accent)]' : 'bg-[var(--danger)]',
        )}
      />
      <span className="mr-auto min-w-0 text-[11px] text-muted">
        {!canSave && !promptsOk
          ? <span className="text-[var(--danger)]">fix the incomplete prompt template</span>
          : !canSave && !allPersonasOk
            ? <span className="text-[var(--danger)]">a persona in the roster is incomplete — fix it before saving</span>
            : 'changes apply on the next spoken line · no mixer restart'}
      </span>
      <Btn className="min-h-9 sm:min-h-0" onClick={onDiscard} disabled={busy}>Discard</Btn>
      <Btn className="min-h-9 sm:min-h-0" tone="accent" onClick={onSave} disabled={busy || !canSave}>
        {busy ? 'Saving…' : 'Save system prompt'}
      </Btn>
    </div>
  );
  const editorFooter = (
    <div className="flex w-full flex-wrap items-center justify-end gap-2">
      {editingPreset && (
        <span className={cn('caption mr-auto min-w-0', !editingError ? 'text-muted' : 'text-[var(--danger)]')}>
          {editingText.length}/{PROMPT_MAX} chars
          {editingError?.name?.message && ` · ${editingError.name.message}`}
          {editingError?.text?.message && ` · ${editingError.text.message}`}
        </span>
      )}
      <Btn className="min-h-9 sm:min-h-0" onClick={() => setEditing(null)}>Back to library</Btn>
    </div>
  );

  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={
          editing === null ? 'system prompt'
            : editing === 'default' ? 'built-in default'
              : 'edit prompt'
        }
        sub={
          editing === null ? 'template library — shared by every persona'
            : editing === 'default' ? 'read-only — New prompt starts from this text'
              : editingPreset?.name.trim() || undefined
        }
        width={720}
        footer={editing === null ? libraryFooter : editorFooter}
      >
        {editing === null ? (
          <>
            <p className="mb-3 max-w-[70ch] text-[12px] leading-[1.6] text-muted">
              One template wraps the DJ&rsquo;s scripted talk (intros, links, idents, time
              checks, programme beats), shared by all personas. The tool-using agents (track
              picker, requests, skill segments) and the multi-voice guest exchanges (banter,
              show open/close) use each persona&rsquo;s name and soul directly instead — only
              the house rules below reach those too. Keep several saved and
              switch between them. Placeholders:{' '}
              <code>{'{name}'}</code> · <code>{'{soul}'}</code> · <code>{'{station}'}</code> ·{' '}
              <code>{'{location}'}</code> · <code>{'{language}'}</code>. <code>{'{location}'}</code> is the
              station&rsquo;s on-air location, not the weather coordinates; drop it if you never
              want the DJ to name a place. Most stations stay on the built-in default.
            </p>
            <div className="grid gap-2">
              {row({
                key: 'default',
                name: 'Built-in default',
                meta: 'ships with SUB/WAVE · read-only',
                isActive: activeId === '',
                onUse: () => onSetActive(''),
                actions: <Btn sm className="min-h-9 sm:min-h-0" onClick={() => setEditing('default')}>View</Btn>,
              })}
              {promptFields.map((f, idx) => {
                const live = watchedPrompts[idx];
                return row({
                  key: f._rhfKey,
                  name: (live?.name ?? f.name).trim() || '(unnamed)',
                  meta: `${(live?.text ?? f.text).trim().length} chars`,
                  isActive: activeId === f.id,
                  invalid: !!errors.djPrompts?.[idx],
                  onUse: () => onSetActive(f.id),
                  actions: (
                    <>
                      <Btn sm className="min-h-9 sm:min-h-0" onClick={() => setEditing(f.id)}>Edit</Btn>
                      <Btn sm className="min-h-9 sm:min-h-0" onClick={() => setConfirmDeleteId(f.id)} disabled={busy}>Delete</Btn>
                    </>
                  ),
                });
              })}
            </div>
            <div className="mt-3">
              <Btn
                className="min-h-9 sm:min-h-0"
                onClick={addPreset}
                disabled={busy || promptFields.length >= PROMPT_PRESET_MAX}
                title={promptFields.length >= PROMPT_PRESET_MAX ? `The library is full (${PROMPT_PRESET_MAX} templates)` : undefined}
              >
                New prompt
              </Btn>
            </div>

            {/* The one operator block that reaches EVERY spoken line: the scripted
                talk the template wraps, the tool-using agents it never touches
                (issue #1182), and the multi-voice cast exchanges (issue #1420). */}
            <div className="mt-5 border-t border-ink/40 pt-4">
              <div className="caption mb-1.5">station house rules</div>
              <p className="mb-2 max-w-[70ch] text-[12px] leading-[1.6] text-muted">
                Appended to <b>everything</b> the DJ speaks — scripted talk, the
                tool-using agents and guest banter alike, whichever template is
                active. Use it for rules
                that must never be skipped: TTS control tags, &ldquo;spell out numbers and
                dates in words&rdquo;, language-specific spelling. Leave empty for none.
              </p>
              <Textarea
                rows={5}
                value={houseRules}
                maxLength={HOUSE_RULES_MAX}
                placeholder="e.g. Spell out numbers, dates and units in words — never digits."
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onHouseRulesChange(e.target.value)}
                className="font-mono text-[12px]"
              />
              <div className="caption mt-1 text-muted">
                {houseRules.trim().length}/{HOUSE_RULES_MAX} chars
              </div>
            </div>
          </>
        ) : editing === 'default' ? (
          <pre className="term max-h-[420px]">{defaultPrompt || '(default unavailable)'}</pre>
        ) : editingPreset ? (
          <div className="grid gap-3">
            <TextField control={control} name={`djPrompts.${editingIdx}.name`} label="name" maxLength={PROMPT_NAME_MAX} />
            <TextareaField control={control} name={`djPrompts.${editingIdx}.text`} label="template" rows={16} className="font-mono text-[12px]" maxLength={PROMPT_MAX} />
            <div>
              <Btn
                onClick={() => setValue(`djPrompts.${editingIdx}.text`, defaultPrompt, { shouldDirty: true, shouldValidate: true })}
                disabled={!defaultPrompt}
              >
                Restore default text
              </Btn>
            </div>
          </div>
        ) : null}
      </Modal>

      <V3AlertDialog
        open={confirmDeleteId !== null}
        onOpenChange={(o) => { if (!o) setConfirmDeleteId(null); }}
        title="Delete prompt"
        description={
          <>
            Remove <b>{deleting?.name.trim() || 'this prompt'}</b> from the library?
            {confirmDeleteId === activeId && ' The station falls back to the built-in default.'}
            {' '}Nothing is permanent until you Save.
          </>
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        danger
        onConfirm={() => {
          if (confirmDeleteId) {
            const idx = promptFields.findIndex(p => p.id === confirmDeleteId);
            if (idx !== -1) onRemovePreset(idx, confirmDeleteId);
          }
          setConfirmDeleteId(null);
        }}
      />
    </>
  );
}
