'use client';
// Searchable voice picker for the long engine voice lists — Piper .onnx files,
// PocketTTS builtins + .wav clones, Chatterbox reference WAVs, cloud provider
// voices. A newsprint-skinned wrapper around the vendored ai-elements
// VoiceSelector dialog (cmdk command palette inside a Radix dialog), replacing
// the plain <Select> those lists outgrew. Controlled exactly like the Select it
// replaces: `value` in, `onChange(id)` out — nothing persists until the
// surrounding form saves.
//
// When `preview` is set, every row gets a small play affordance
// (VoiceSelectorPreview) that reuses the existing POST /settings/tts/preview
// endpoint — the same one behind "Play sample" — so a voice can be auditioned
// in-place before it's chosen. One sample plays at a time; closing the dialog
// stops playback and revokes the object URL.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import type { AdminAuth } from '../../../lib/adminAuth';
import { cn } from '../../../lib/cn';
import {
  VoiceSelector,
  VoiceSelectorContent,
  VoiceSelectorEmpty,
  VoiceSelectorGroup,
  VoiceSelectorInput,
  VoiceSelectorItem,
  VoiceSelectorList,
  VoiceSelectorName,
  VoiceSelectorPreview,
  VoiceSelectorTrigger,
} from '../../ai-elements/voice-selector';
import { fetchPreviewSample } from './previewApi';

export interface VoicePickerVoice {
  // Value handed to onChange when the row is picked (sentinels included —
  // the call site owns any sentinel→'' mapping, exactly as with <Select>).
  id: string;
  label: string;
  // Small uppercase note pinned to the row's right edge (e.g. "missing").
  hint?: string;
  // Voice value to audition for this row; defaults to `id`. Pass null to hide
  // the preview button (e.g. the "Custom voice id…" action row, which isn't a
  // voice). Pass '' to audition an engine's built-in default.
  previewVoice?: string | null;
}

export interface VoicePickerGroup {
  // Group heading (e.g. "Built-in" vs "Custom (cloned)"). Omit for a flat list.
  label?: string;
  voices: VoicePickerVoice[];
}

// Everything the per-row preview needs to call POST /settings/tts/preview.
export interface VoicePickerPreviewParams {
  engine: string;
  cloudProvider?: string;
  speed?: number;
  lang?: string;
  adminFetch: AdminAuth['adminFetch'];
}

interface VoicePickerProps {
  value: string;
  onChange: (id: string) => void;
  groups: VoicePickerGroup[];
  // Dialog heading (visible, tiny-uppercase newsprint style).
  title: string;
  // Trigger text when `value` matches no row and is empty.
  placeholder?: string;
  searchPlaceholder?: string;
  // Present = every row gets a play-sample affordance.
  preview?: VoicePickerPreviewParams;
  disabled?: boolean;
  className?: string;
}

type PreviewPhase = { voice: string; phase: 'loading' | 'playing' };

export function VoicePicker({
  value, onChange, groups, title,
  placeholder = 'Choose a voice…',
  searchPlaceholder = 'Search voices…',
  preview, disabled, className,
}: VoicePickerProps) {
  const [open, setOpen] = useState(false);

  // In-dialog sample playback — one voice at a time.
  const [previewing, setPreviewing] = useState<PreviewPhase | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  // Monotonic token: bumping it invalidates any fetch still in flight.
  const seqRef = useRef(0);

  const stopPreview = useCallback(() => {
    seqRef.current += 1;
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    setPreviewing(null);
  }, []);

  // Stop playback + revoke the object URL if the picker unmounts mid-sample.
  useEffect(() => () => stopPreview(), [stopPreview]);

  const handleOpenChange = (o: boolean) => {
    setOpen(o);
    if (!o) { stopPreview(); setPreviewError(null); }
  };

  const togglePreview = async (voiceValue: string) => {
    if (!preview) return;
    // Clicking the playing/loading row again stops (or cancels) it.
    if (previewing?.voice === voiceValue) { stopPreview(); return; }
    stopPreview();
    setPreviewError(null);
    const seq = seqRef.current;
    setPreviewing({ voice: voiceValue, phase: 'loading' });
    const res = await fetchPreviewSample(preview.adminFetch, {
      engine: preview.engine,
      voice: voiceValue,
      cloudProvider: preview.cloudProvider,
      speed: preview.speed,
      lang: preview.lang,
    });
    // Another row (or a close) superseded this request while it was in flight.
    if (seq !== seqRef.current) return;
    if (!res.ok) { setPreviewing(null); setPreviewError(res.message); return; }
    const url = URL.createObjectURL(res.blob);
    urlRef.current = url;
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.onended = () => { if (audioRef.current === audio) stopPreview(); };
    audio.onerror = () => {
      if (audioRef.current !== audio) return;
      stopPreview();
      setPreviewError('Could not play sample');
    };
    try {
      await audio.play();
    } catch {
      if (audioRef.current === audio) { stopPreview(); setPreviewError('Could not play sample'); }
      return;
    }
    if (seq === seqRef.current) setPreviewing({ voice: voiceValue, phase: 'playing' });
  };

  const selected = groups.flatMap(g => g.voices).find(v => v.id === value);
  const triggerLabel = selected?.label || value;

  return (
    <VoiceSelector
      value={value}
      onValueChange={v => { if (typeof v === 'string') onChange(v); }}
      open={open}
      onOpenChange={handleOpenChange}
    >
      {/* Trigger — mirrors the newsprint SelectTrigger it replaces, with a
          combobox affordance instead of the single chevron. */}
      <VoiceSelectorTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex w-full items-center justify-between gap-2 border border-ink bg-field px-3 py-[9px] text-left text-[13px] text-ink focus:ring-1 focus:ring-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          <span className={cn('line-clamp-1 min-w-0', !triggerLabel && 'text-muted')}>
            {triggerLabel || placeholder}
          </span>
          <ChevronsUpDown className="h-4 w-4 flex-none opacity-50" />
        </button>
      </VoiceSelectorTrigger>
      <VoiceSelectorContent title={title} className="max-w-md gap-0 shadow-drawer">
        <div className="border-b border-ink px-4 py-2.5 pr-10 text-[10px] font-bold tracking-[0.2em] text-vermilion uppercase">
          {title}
        </div>
        <VoiceSelectorInput placeholder={searchPlaceholder} />
        <VoiceSelectorList>
          <VoiceSelectorEmpty>No voices match.</VoiceSelectorEmpty>
          {groups.filter(g => g.voices.length > 0).map((g, i) => (
            <VoiceSelectorGroup key={g.label || i} heading={g.label}>
              {g.voices.map(v => {
                const previewValue = v.previewVoice === null ? null : (v.previewVoice ?? v.id);
                const isSelected = v.id === value;
                return (
                  <VoiceSelectorItem
                    key={v.id}
                    value={v.id}
                    // cmdk filters on `value` (the raw id) — labels ride along
                    // so "rachel" still finds an ElevenLabs voice-id hash.
                    keywords={[v.label]}
                    onSelect={() => { onChange(v.id); handleOpenChange(false); }}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'size-2 flex-none rounded-full border',
                        isSelected ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-current opacity-30',
                      )}
                    />
                    <VoiceSelectorName className="text-[13px] font-normal">{v.label}</VoiceSelectorName>
                    {v.hint && (
                      <span className="flex-none text-[9px] font-bold tracking-[0.14em] uppercase opacity-60">
                        {v.hint}
                      </span>
                    )}
                    {preview && previewValue !== null && (
                      <VoiceSelectorPreview
                        loading={previewing?.voice === previewValue && previewing.phase === 'loading'}
                        playing={previewing?.voice === previewValue && previewing.phase === 'playing'}
                        onPlay={() => { void togglePreview(previewValue); }}
                        // Inherit the row's ink so the button stays legible on
                        // the inverted (highlighted) row.
                        className="border-current text-current"
                      />
                    )}
                  </VoiceSelectorItem>
                );
              })}
            </VoiceSelectorGroup>
          ))}
        </VoiceSelectorList>
        {previewError && (
          <div className="border-t border-ink px-4 py-2 text-[10px] leading-[1.4] text-[var(--danger)]">
            {previewError}
          </div>
        )}
      </VoiceSelectorContent>
    </VoiceSelector>
  );
}
