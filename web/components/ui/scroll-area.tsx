"use client"

import * as React from "react"
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"

import { cn } from "@/lib/cn"

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    className={cn("group/scroll-area relative overflow-hidden", className)}
    {...props}
  >
    {/* Inherit max-height so capped viewports can scroll. Contain overscroll only on axes with
        visible Radix scrollbars; unconditional containment traps the page wheel. Check from the
        root because horizontal bars may be inside the viewport. */}
    <ScrollAreaPrimitive.Viewport
      className="h-full max-h-[inherit] w-full rounded-[inherit] group-has-[div[data-orientation=horizontal]]/scroll-area:overscroll-x-contain group-has-[div[data-orientation=vertical]]/scroll-area:overscroll-y-contain"
    >
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
))
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    // forceMount enables hover fades without remounting the bar. Radix still omits bars on axes that do not overflow.
    forceMount
    className={cn(
      "flex touch-none opacity-0 transition-opacity duration-150 select-none",
      "data-[state=hidden]:pointer-events-none data-[state=visible]:opacity-100",
      orientation === "vertical" &&
        "h-full w-2.5 border-l border-l-transparent p-[1px]",
      orientation === "horizontal" &&
        "h-2.5 flex-col border-t border-t-transparent p-[1px]",
      className
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
))
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName

export { ScrollArea, ScrollBar }
