'use client';


import { cn } from '../../lib/cn';

export interface RosterAvatarProps {
  src: string | null;
  initials: string;
  // 'sm' is the table's row face; 'xs' builds the overlapping guest cluster.
  size?: 'sm' | 'xs';
  className?: string;
}

export function RosterAvatar({ src, initials, size = 'sm', className }: RosterAvatarProps) {
  return (
    <span
      className={cn(
        'relative grid flex-none place-items-center overflow-hidden border border-ink bg-[var(--ink-softer)]',
        size === 'sm' ? 'size-7' : 'size-5',
        className,
      )}
    >
      <span className={cn('font-extrabold text-muted', size === 'sm' ? 'text-[9px]' : 'text-[7px]')}>
        {initials || '—'}
      </span>
      {src && (
        <img
          src={src}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
        />
      )}
    </span>
  );
}

