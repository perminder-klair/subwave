'use client';

import { useMemo } from 'react';
import PlayerApp from '@/components/PlayerApp';
import { StationOriginProvider, originForChannel } from '@/lib/stationOrigin';

// Client wrapper: pins the whole player tree to the channel's origin. The
// channel id arrives slug-validated by the route pattern's consumers server-
// side; originForChannel URI-encodes it defensively anyway.
export default function ChannelPlayer({ channelId }: { channelId: string }) {
  const origin = useMemo(() => originForChannel(channelId), [channelId]);
  return (
    <StationOriginProvider value={origin}>
      <PlayerApp />
    </StationOriginProvider>
  );
}
