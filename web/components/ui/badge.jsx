import * as React from "react"
import { cva } from "class-variance-authority";

import { cn } from "@/lib/cn"

/* Retuned for SUB/WAVE's newsprint aesthetic — the legacy `.tag` pill:
   sharp corners, tiny uppercase letter-spaced text, 1px border. Variants
   map to the old tone classes (default = muted outline, ink, accent, solid). */
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 border px-2 py-[3px] text-[10px] font-bold uppercase tracking-[0.14em] transition-colors focus:outline-none focus:ring-1 focus:ring-ring",
  {
    variants: {
      variant: {
        default: "border-[color:var(--separator-strong)] text-[color:var(--muted)]",
        ink: "border-ink text-ink",
        accent: "border-[var(--accent)] text-[var(--accent)]",
        solid: "border-ink bg-ink text-bg",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant,
  ...props
}) {
  return (<span className={cn(badgeVariants({ variant }), className)} {...props} />);
}

export { Badge, badgeVariants }
