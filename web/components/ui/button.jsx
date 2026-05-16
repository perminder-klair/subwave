import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva } from "class-variance-authority";

import { cn } from "@/lib/cn"

/* Retuned for SUB/WAVE's newsprint aesthetic: sharp corners, JetBrains Mono,
   uppercase letter-spaced labels, 1px ink borders, no shadows. The `variant`
   names map to the legacy `.btn` tones (default/outline, solid, accent,
   destructive = danger, ghost). */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.2em] cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border border-ink bg-transparent text-ink hover:bg-[var(--ink-soft)]",
        outline:
          "border border-ink bg-transparent text-ink hover:bg-[var(--ink-soft)]",
        solid:
          "border border-ink bg-ink text-bg hover:opacity-85",
        accent:
          "border border-[var(--accent)] bg-[var(--accent)] text-white hover:opacity-90",
        destructive:
          "border border-[var(--destructive)] bg-[var(--destructive)] text-white hover:opacity-90",
        secondary:
          "border border-ink bg-secondary text-ink hover:bg-[var(--ink-soft)]",
        ghost:
          "border border-[color:var(--separator-strong)] bg-transparent text-[color:var(--muted)] hover:bg-[var(--ink-soft)]",
        link: "text-[var(--accent)] underline-offset-4 hover:underline",
      },
      size: {
        default: "px-3.5 py-[7px]",
        sm: "px-2.5 py-[5px] text-[9px]",
        lg: "px-[22px] py-[11px] text-[11px]",
        icon: "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

const Button = React.forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props} />
  );
})
Button.displayName = "Button"

export { Button, buttonVariants }
