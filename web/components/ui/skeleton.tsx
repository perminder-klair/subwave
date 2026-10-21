import * as React from "react"

import { cn } from "@/lib/cn"

/* Newsprint skeleton. The base `Skeleton` is a single bar; the named shapes
   below compose it into the content silhouettes the admin panels render.

   `motion-reduce:animate-none` kills the pulse for reduced-motion users. Bar
   widths come from a fixed cycle, never Math.random, so server and client render
   identical markup — random widths would hydration-mismatch and trip the repo's
   react purity rule. */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-none bg-[var(--ink-soft)] motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  )
}

// Indexed by position so the silhouette looks organic with no per-render
// randomness.
const BAR_W = ["w-[68%]", "w-[82%]", "w-[54%]", "w-[76%]", "w-[46%]", "w-[88%]"]
const widthAt = (i: number) => BAR_W[i % BAR_W.length]

interface ShapeProps {
  className?: string
  label?: string
}

/* One polite live region + visually-hidden label per shape, so assistive tech
   hears "Loading …" once while the bars stay aria-hidden. */
function LoadingBox({
  className,
  label = "Loading",
  children,
}: ShapeProps & { children: React.ReactNode }) {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{label}…</span>
      {children}
    </div>
  )
}

function SkeletonText({
  lines = 3,
  className,
  label,
}: { lines?: number } & ShapeProps) {
  return (
    <LoadingBox label={label} className={cn("space-y-2", className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          aria-hidden
          className={cn("h-3.5", i === lines - 1 ? "w-[40%]" : widthAt(i))}
        />
      ))}
    </LoadingBox>
  )
}

function SkeletonRows({
  rows = 5,
  className,
  label,
}: { rows?: number } & ShapeProps) {
  return (
    <LoadingBox
      label={label}
      className={cn(
        "divide-y divide-separator-strong border border-separator-strong",
        className,
      )}
    >
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} aria-hidden className="flex items-center gap-3 px-3 py-3">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className={cn("h-3.5", widthAt(i))} />
            <Skeleton className="h-2.5 w-[35%]" />
          </div>
          <Skeleton className="h-5 w-14 shrink-0" />
        </div>
      ))}
    </LoadingBox>
  )
}

function SkeletonCards({
  cards = 6,
  className,
  label,
}: { cards?: number } & ShapeProps) {
  return (
    <LoadingBox
      label={label}
      className={cn(
        "grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3",
        className,
      )}
    >
      {Array.from({ length: cards }).map((_, i) => (
        <div key={i} aria-hidden className="border border-separator-strong p-3">
          <Skeleton className="mb-3 h-24 w-full" />
          <Skeleton className={cn("h-3.5", widthAt(i))} />
          <Skeleton className="mt-2 h-2.5 w-[50%]" />
        </div>
      ))}
    </LoadingBox>
  )
}

function SkeletonForm({
  fields = 4,
  className,
  label,
}: { fields?: number } & ShapeProps) {
  return (
    <LoadingBox label={label} className={cn("space-y-4", className)}>
      {Array.from({ length: fields }).map((_, i) => (
        <div key={i} aria-hidden className="space-y-2">
          <Skeleton className="h-2.5 w-24" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </LoadingBox>
  )
}

export {
  Skeleton,
  SkeletonText,
  SkeletonRows,
  SkeletonCards,
  SkeletonForm,
}
