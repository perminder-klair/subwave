// DJ handoffs (discussion #247) — air a spoken changeover when one persona
// signs off and a different one takes the shift.
//
// session.maybeRoll() detects the changeover (a hard roll whose incoming
// persona differs from the outgoing one) and stashes a pendingHandoff on the
// session. This module drains it at the next clean between-tracks moment — the
// queue watcher calls maybeAir() right after maybeRoll(), before it picks the
// next track. Two lines air back to back on the heavy-duck voice channel: the
// outgoing DJ passes the mic by name, then the incoming DJ acknowledges. Each
// line is voiced by its OWN persona (queue.announce's `persona` override), not
// the now-effective one.
//
// Decoupling detection from airing is deliberate: a roll can be triggered by
// the scheduler or a listener request between watcher ticks, but the handoff
// should only ever land between songs. takePendingHandoff() returns the pair
// exactly once, so a deferred handoff airs at the next transition and never
// twice.

import * as settings from '../settings.js';
import * as session from './session.js';
import * as dj from '../llm/dj.js';
import { withTrace, logEvent } from '../observability/events.js';

// Air a pending DJ handoff, if one is queued and the feature is on. Best-effort:
// any failure is swallowed so a flaky LLM/TTS call never blocks the track pick
// that follows in the watcher.
export async function maybeAir(queue: any, ctx: any): Promise<void> {
  if (!settings.get().llm?.handoffs) return;
  const pending = session.takePendingHandoff();
  if (!pending) return;

  // Re-resolve full persona objects — takePendingHandoff only carries {id,name},
  // and we need each persona's `tts` config to voice its line. If a persona was
  // deleted between the roll and now, fall back to the stored stub (no tts →
  // announce voices it with the engine default rather than going silent).
  const outgoing = settings.resolvePersonaById(pending.outgoing?.id) || pending.outgoing;
  const incoming = settings.resolvePersonaById(pending.incoming?.id) || pending.incoming;
  if (!outgoing?.name || !incoming?.name) return;

  // Best-effort: a flaky LLM/TTS call must not bubble up and skip the track pick
  // that runs next in the watcher. The handoff is already claimed, so a failure
  // simply means this one changeover goes unspoken — never a missed pick.
  try {
    await withTrace({ kind: 'handoff', from: outgoing.name, to: incoming.name }, async () => {
      const slotLabel = dj.handoffSlotLabel(ctx);

      // Outgoing DJ signs off — in the outgoing voice.
      const signoff = await dj.generateHandoff({ outgoing, incoming, context: ctx, slotLabel });
      await queue.announce(signoff, 'handoff', { persona: outgoing });

      // Incoming DJ acknowledges — in the incoming voice. writeHandoff serialises
      // the two say.txt writes, so this lands only after the sign-off has aired.
      const ack = await dj.generateHandoffAck({ incoming, outgoing, context: ctx, slotLabel });
      await queue.announce(ack, 'handoff', { persona: incoming });

      logEvent('handoff.aired', { from: outgoing.name, to: incoming.name, slot: slotLabel });
    });
  } catch (err: any) {
    queue.log('error', `DJ handoff failed: ${err?.message ?? err}`);
  }
}
