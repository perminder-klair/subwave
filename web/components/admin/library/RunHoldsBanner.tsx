// What the last run held back for the operator: a mass removal, or a mass
// replaced-file clear. Such a run still exits 0, so the failure banner never
// shows, and the panel drops `progress` once a run stops, so this is the only
// place an operator who doesn't open the log learns of it. The messages come
// from the run (TaggerState.holds), and go when the next run starts.
//
// `heldRows` is the durable half (controller music/held-rows.ts): library rows
// a complete walk kept but did not see, out of picks until a walk sees them
// again or the operator removes them here. It outlives a restart, so the
// action shows whether or not this controller saw the run that held them.
import { useState } from 'react';
import { V3AlertDialog } from '../../ui/alert-dialog';

const num = (n: number) => n.toLocaleString('en-GB');

export default function RunHoldsBanner({
  holds,
  heldRows,
  onViewLog,
  onConfirmPrune,
  pruning = false,
}: {
  holds?: string[] | null;
  heldRows?: number | null;
  onViewLog: () => void;
  onConfirmPrune?: () => void;
  pruning?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const held = heldRows && heldRows > 0 ? heldRows : 0;
  if (!holds?.length && !held) return null;
  return (
    <div
      role="status"
      className="mx-4 mt-6 flex flex-wrap items-start gap-x-3 gap-y-1 border border-l-[3px] border-[var(--warn,var(--accent))] px-3 py-2 text-[11px] leading-[1.5] text-ink !normal-case sm:mx-6"
    >
      <div className="grid min-w-0 flex-1 gap-1">
        {holds?.map(text => (
          <p key={text}>
            <b>On hold.</b> {text}
          </p>
        ))}
        {held > 0 && !holds?.length && (
          <p>
            <b>Kept out of picks.</b> {num(held)} library track{held === 1 ? ' is' : 's are'} not on the music
            source. Their tags and analysis are kept until you remove them, or until a walk finds them again.
          </p>
        )}
      </div>
      {held > 0 && onConfirmPrune && (
        <button
          type="button"
          className="font-bold text-vermilion underline-offset-2 hover:underline disabled:opacity-50"
          onClick={() => setConfirming(true)}
          disabled={pruning}
        >
          {pruning ? 'Removing…' : 'Remove them'}
        </button>
      )}
      <button
        type="button"
        className="font-bold text-vermilion underline-offset-2 hover:underline"
        onClick={onViewLog}
      >
        View log →
      </button>
      {onConfirmPrune && (
        <V3AlertDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={`Remove ${num(held)} track${held === 1 ? '' : 's'} the music source no longer has?`}
          description={
            'This walks the music source once more and deletes every library row it still does not see, with its ' +
            'mood tags, analysis and embeddings. Do this when the tracks are really gone or the station moved to a ' +
            'different library. If a music folder or share is only unmounted, mount it and run Reconcile instead: ' +
            'switching back to a library after this means tagging and analysing it again.'
          }
          confirmLabel="Remove them"
          danger
          onConfirm={() => {
            setConfirming(false);
            onConfirmPrune();
          }}
        />
      )}
    </div>
  );
}
