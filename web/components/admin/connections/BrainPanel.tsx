'use client';

import { useId, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useBrainKeySetting } from './key-preferences';

/** Mobile expansion is independent of the remembered desktop fold. */
export default function BrainPanel({ label, className, children }: { label: string; className: string; children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const setting = label === 'Layout' ? 'layoutFolded' : label === 'Key' ? 'keyFolded' : 'controlsFolded';
  const [folded, setFolded] = useBrainKeySetting(setting);
  const contentId = useId();
  const toggleClass = 'v3-focus flex min-h-11 w-full items-center justify-between gap-2 px-2 text-[11px] hover:bg-overlay md:min-h-8';
  return <div className={className}>
    <button type="button" aria-expanded={mobileOpen} aria-controls={contentId}
      onClick={() => setMobileOpen(value => !value)} className={`${toggleClass} md:hidden`}>
      {label}{mobileOpen ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
    </button>
    <button type="button" aria-expanded={!folded} aria-controls={contentId}
      onClick={() => setFolded(value => !value)} className={`${toggleClass} hidden md:flex`}>
      {label}{folded ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
    </button>
    <div id={contentId} className={`${mobileOpen ? 'block' : 'hidden'} ${folded ? 'md:hidden' : 'md:block'}`}>{children}</div>
  </div>;
}
