import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"

import { cn } from "@/lib/cn"

/* Retuned for SUB/WAVE's newsprint aesthetic: sharp 38×20 box, 1px ink
   border, square ink thumb that fills white when the accent-filled track
   is on. Matches the legacy `.toggle` control. */
const Switch = React.forwardRef(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "peer relative inline-flex h-5 w-[38px] shrink-0 cursor-pointer items-center border border-ink bg-transparent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 data-[state=checked]:border-[var(--accent)] data-[state=checked]:bg-[var(--accent)]",
      className
    )}
    {...props}
    ref={ref}>
    <SwitchPrimitives.Thumb
      className="pointer-events-none block size-3.5 translate-x-[2px] bg-ink transition-transform data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-white" />
  </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
