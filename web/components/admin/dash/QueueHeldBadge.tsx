export default function QueueHeldBadge({ sent }: { sent?: boolean }) {
  if (sent === true) return null;

  return (
    <span
      title="Held by controller — not handed to the mixer yet"
      className="shrink-0 border border-ink/20 px-1 py-0.5 text-[8px] font-bold tracking-[0.14em] whitespace-nowrap text-muted uppercase"
    >
      Held
    </span>
  );
}
