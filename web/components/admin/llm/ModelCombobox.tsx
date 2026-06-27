'use client';
// Searchable model picker. Renders as a trigger button that shows the selected
// model (or placeholder). Clicking opens an inline popover with a text filter +
// scrollable list built on cmdk. Falls back (at the call site) to a plain input
// when no models are available (discovery hasn't run / returned nothing).
//
// Extracted from SettingsPanel so the admin Settings tab and the onboarding
// wizard share one model picker instead of each rolling their own.
import { useEffect, useRef, useState } from 'react';
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
  className?: string;
}

export function ModelCombobox({ models, value, onChange, placeholder = 'Select a model', disabled, className }: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [direction, setDirection] = useState<'up' | 'down'>('down');

  // Recompute position when opening
  const openDropdown = () => {
    if (triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom;
      const dir = spaceBelow < 300 ? 'up' : 'down';
      setDirection(dir);

      const top = dir === 'down'
        ? r.bottom + window.scrollY + 4
        : r.top + window.scrollY - 4;

      setRect({ top, left: r.left + window.scrollX, width: r.width });
    }
    setOpen(true);
    setSearch('');
  };

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        triggerRef.current && !triggerRef.current.contains(e.target as Node) &&
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on scroll/resize
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (dropdownRef.current && dropdownRef.current.contains(e.target as Node)) return;
      setOpen(false);
      setSearch('');
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);

  const filtered = search.trim()
    ? models.filter(m => m.toLowerCase().includes(search.toLowerCase()))
    : models;

  const displayValue = value || placeholder;

  const dropdown = open && rect ? createPortal(
    <div
      ref={dropdownRef}
      style={{
        position: 'absolute',
        top: rect.top,
        left: rect.left,
        width: Math.max(rect.width, 240),
        zIndex: 9999,
        transform: direction === 'up' ? 'translateY(-100%)' : undefined,
      }}
      className="border border-ink bg-bg shadow-drawer"
    >
      <Command shouldFilter={false}>
        {direction === 'down' && (
          <CommandInput
            placeholder="Filter models…"
            value={search}
            onValueChange={setSearch}
          />
        )}
        <CommandList>
          {filtered.length === 0
            ? <CommandEmpty>No models match.</CommandEmpty>
            : (
              <CommandGroup>
                {filtered.map(m => (
                  <CommandItem
                    key={m}
                    value={m}
                    onSelect={() => { onChange(m); setOpen(false); setSearch(''); }}
                    data-selected={m === value}
                  >
                    <span className="truncate">{m}</span>
                    {m === value && (
                      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                        <path d="M2 6.5l3.5 3.5 5.5-6" />
                      </svg>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )
          }
        </CommandList>
        {direction === 'up' && (
          <CommandInput
            placeholder="Filter models…"
            value={search}
            onValueChange={setSearch}
            wrapperClassName="border-t border-b-0"
          />
        )}
      </Command>
    </div>,
    document.body,
  ) : null;

  return (
    <div className={cn('w-full max-w-[360px]', className)}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => open ? (setOpen(false), setSearch('')) : openDropdown()}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 border border-ink bg-bg px-3 text-sm',
          'focus:outline-none disabled:cursor-not-allowed disabled:opacity-40',
          open && 'ring-1 ring-ink',
        )}
      >
        <span className={cn('truncate', !value && 'text-muted')}>{displayValue}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" className="shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2 4l4 4 4-4" />
        </svg>
      </button>
      {dropdown}
    </div>
  );
}
