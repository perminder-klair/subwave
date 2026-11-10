'use client';

import { cn } from '../../../lib/cn';
import { Conversation, ConversationContent } from '../../ai-elements/conversation';
import { Message, MessageContent } from '../../ai-elements/message';
import type { DebugSession } from './types';
import { mapChatRole } from './TtsPanels';

export function SessionChat({ session }: { session: DebugSession }) {
  const msgs = session.messages || [];
  return (
    // StickToBottom's inner scroll element is height:100%, so it needs a definite
    // outer height to scroll. Short sessions size to content instead.
    <Conversation className={cn('w-full', msgs.length > 6 ? 'h-[360px]' : 'h-auto')}>
      <ConversationContent className="gap-1.5 p-0">
        {session.handoff && (
          <div className="caption italic">
            ↪ continuing from {session.handoff}
          </div>
        )}
        {msgs.length === 0 && (
          <span className="field-hint italic">no turns yet</span>
        )}
        {msgs.map((m, i) => (
          <Message key={i} from={mapChatRole(m.role)} className="max-w-full gap-0.5">
            <span className="flex items-baseline gap-2">
              <span className="mono-num text-[10px] text-muted">
                {m.t ? new Date(m.t).toLocaleTimeString('en-GB', { hour12: false }) : '—'}
              </span>
              <span
                className={cn(
                  'text-[9px] tracking-[0.12em] uppercase',
                  m.role === 'dj' || m.role === 'segment'
                    ? 'text-vermilion'
                    : m.role === 'track'
                      ? 'text-ink'
                      : 'text-muted',
                )}
              >
                {m.role}{m.kind ? `·${m.kind}` : ''}
              </span>
            </span>
            <MessageContent className="rounded-none text-[12px] group-[.is-user]:rounded-none group-[.is-user]:bg-[var(--overlay)] group-[.is-user]:px-2.5 group-[.is-user]:py-1.5 group-[.is-user]:text-ink">
              {/* Render raw session text to preserve asterisks and underscores. */}
              <div className="break-words whitespace-pre-wrap">{m.text}</div>
            </MessageContent>
          </Message>
        ))}
      </ConversationContent>
    </Conversation>
  );
}


