'use client';

import { useState, type ReactNode } from 'react';
import { CircleHelp } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';

/** The same explanation is available on hover, keyboard focus and a tap. */
export default function NotesHelp({ text, children }: { text: string; children?: ReactNode }) {
  const [open,setOpen]=useState(false);
  return <TooltipProvider delayDuration={250}><Tooltip open={open} onOpenChange={setOpen}>
    <TooltipTrigger asChild><button type="button" aria-label={text} onClick={event=>{event.preventDefault();setOpen(!open);}}
      className="inline-flex size-11 shrink-0 items-center justify-center text-muted hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 md:size-8">
      <CircleHelp className="size-4" aria-hidden="true" />
    </button></TooltipTrigger>
    <TooltipContent className="max-w-72 rounded-none border border-border bg-ink leading-5 whitespace-normal text-bg">{children ?? text}</TooltipContent>
  </Tooltip></TooltipProvider>;
}
