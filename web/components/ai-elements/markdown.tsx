"use client";

import type { ComponentProps } from "react";
import { defaultComponents, type Components } from "streamdown";
import { cn } from "@/lib/cn";

function InlineCode({ className, ...props }: ComponentProps<typeof defaultComponents.code>) {
  return (
    <defaultComponents.code
      {...props}
      className={cn("bg-surface text-foreground", className)}
    />
  );
}

// SUB/WAVE's `muted` token is text ink; Streamdown's default `bg-muted`
// therefore needs a surface token and an explicit foreground for inline code.
export const markdownComponents = { inlineCode: InlineCode } satisfies Components;
