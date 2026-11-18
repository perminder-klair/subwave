// What the last run held back for the operator: a mass removal, or a mass
// replaced-file clear. Such a run still exits 0, so the failure banner never
// shows, and the panel drops `progress` once a run stops, so this is the only
// place an operator who doesn't open the log learns of it. The messages come
// from the run (TaggerState.holds), and go when the next run starts.
export default function RunHoldsBanner({
  holds,
  onViewLog,
}: {
  holds?: string[] | null;
  onViewLog: () => void;
}) {
  if (!holds?.length) return null;
  return (
    <div
      role="status"
      className="mx-4 mt-6 flex flex-wrap items-start gap-x-3 gap-y-1 border border-l-[3px] border-[var(--warn,var(--accent))] px-3 py-2 text-[11px] leading-[1.5] text-ink !normal-case sm:mx-6"
    >
      <div className="grid min-w-0 flex-1 gap-1">
        {holds.map(text => (
          <p key={text}>
            <b>On hold.</b> {text}
          </p>
        ))}
      </div>
      <button
        type="button"
        className="font-bold text-vermilion underline-offset-2 hover:underline"
        onClick={onViewLog}
      >
        View log →
      </button>
    </div>
  );
}
