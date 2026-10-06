'use client';
// Shared by Settings and onboarding. Keep the popup anchored through page scroll
// and virtual-keyboard viewport changes; neither is an outside interaction.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../../lib/cn';
import {
  Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem,
} from '../../ui/command';

interface ModelComboboxProps {
  models: string[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  allowCustom?: boolean;
  className?: string;
}

export function ModelCombobox({ models, value, onChange, placeholder = 'Select a model', disabled, allowCustom = false, className }: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number; up: boolean } | null>(null);

  const positionDropdown = useCallback(() => {
    if (!triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const below = top + height - r.bottom - 8;
    const above = r.top - top - 8;
    const up = below < 300 && above > below;
    const popupWidth = Math.min(Math.max(r.width, 240), width - 16);
    setRect({
      top: (up ? r.top - 4 : r.bottom + 4) + window.scrollY,
      left: Math.max(left + 8, Math.min(r.left, left + width - popupWidth - 8)) + window.scrollX,
      width: popupWidth,
      height: Math.max(0, Math.min(380, up ? above : below)),
      up,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus({ preventScroll: true });
    const outside = (e: PointerEvent) => {
      if (!triggerRef.current?.contains(e.target as Node) && !dropdownRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    };
    const reposition = (e: Event) => {
      if (e.target instanceof Node && dropdownRef.current?.contains(e.target)) return;
      positionDropdown();
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', reposition);
    viewport?.addEventListener('scroll', reposition);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      viewport?.removeEventListener('resize', reposition);
      viewport?.removeEventListener('scroll', reposition);
    };
  }, [open, positionDropdown]);

  const close = () => {
    setOpen(false);
    setSearch('');
    triggerRef.current?.focus({ preventScroll: true });
  };
  const select = (model: string) => { onChange(model); close(); };
  const query = search.trim();
  const filtered = query
    ? models.filter(m => m.toLowerCase().includes(query.toLowerCase()))
    : models;
  const custom = allowCustom && query && !models.includes(query);

  const dropdown = open && rect ? createPortal(
    <div
      ref={dropdownRef}
      style={{
        position: 'absolute',
        top: rect.top,
        left: rect.left,
        width: rect.width,
        maxHeight: rect.height,
        zIndex: 9999,
        transform: rect.up ? 'translateY(-100%)' : undefined,
      }}
      className="overflow-hidden border border-ink bg-bg shadow-drawer"
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        if (e.key === 'Tab') { setOpen(false); setSearch(''); }
      }}
    >
      <Command shouldFilter={false}>
        <CommandInput
          ref={inputRef}
          aria-label={allowCustom ? 'Search or enter model ID' : 'Filter models'}
          placeholder={allowCustom ? 'Search or enter model ID…' : 'Filter models…'}
          value={search}
          onValueChange={setSearch}
          className="min-w-0 text-base sm:text-sm"
        />
        <CommandList style={{ maxHeight: Math.max(0, rect.height - 50) }}>
          {filtered.length === 0 && !custom
            ? <CommandEmpty>No models match.</CommandEmpty>
            : (
              <CommandGroup>
                {filtered.map(m => (
                  <CommandItem key={m} value={m} onSelect={() => select(m)}>
                    <span className="truncate">{m}</span>
                    {m === value && (
                      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                        <path d="M2 6.5l3.5 3.5 5.5-6" />
                      </svg>
                    )}
                  </CommandItem>
                ))}
                {custom && (
                  <CommandItem value={query} onSelect={() => select(query)}>
                    <span className="truncate">Use “{query}”</span>
                  </CommandItem>
                )}
              </CommandGroup>
            )}
        </CommandList>
      </Command>
    </div>,
    document.body,
  ) : null;

  return (
    <div className={cn('w-full max-w-[360px] min-w-0', className)}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (open) close();
          else { positionDropdown(); setSearch(''); setOpen(true); }
        }}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 border border-ink bg-bg px-3 text-sm',
          'focus:outline-none disabled:cursor-not-allowed disabled:opacity-40',
          open && 'ring-1 ring-ink',
        )}
      >
        <span className={cn('truncate', !value && 'text-muted')}>{value || placeholder}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" className="shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2 4l4 4 4-4" />
        </svg>
      </button>
      {dropdown}
    </div>
  );
}
