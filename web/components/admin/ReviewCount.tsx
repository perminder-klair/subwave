import { cn } from '../../lib/cn';

export default function ReviewCount({ count, className }: { count: number; className?: string }) {
  if (!Number.isInteger(count) || count < 1) return null;
  return (
    <span className={cn('shrink-0 border border-primary bg-primary px-1.5 py-[2px] text-center font-mono text-[10px] leading-none font-bold text-primary-foreground', className)}>
      {String(count).padStart(2, '0')}<span className="sr-only"> ready for your input</span>
    </span>
  );
}
