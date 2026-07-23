import * as React from "react"

import { cn } from "@/lib/cn"

/* Newsprint skeleton — sharp corners, faint ink fill (matches the console's
   loading placeholders). */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-none bg-[var(--ink-soft)]", className)}
      {...props}
    />
  )
}

export { Skeleton }
