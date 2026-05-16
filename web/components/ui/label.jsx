import * as React from "react"
import * as LabelPrimitive from "@radix-ui/react-label"
import { cva } from "class-variance-authority";

import { cn } from "@/lib/cn"

/* Retuned to SUB/WAVE's newsprint field-label: tiny uppercase letter-spaced
   ink caption, matching the legacy `.field-label`. */
const labelVariants = cva(
  "text-[10px] font-bold uppercase tracking-[0.22em] text-foreground leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
)

const Label = React.forwardRef(({ className, ...props }, ref) => (
  <LabelPrimitive.Root ref={ref} className={cn(labelVariants(), className)} {...props} />
))
Label.displayName = LabelPrimitive.Root.displayName

export { Label }
