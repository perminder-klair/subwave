// Per-station live indicator for the Discover list, mirroring the web
// StationCard probe: fetch the station's /api/now-playing and show an ON AIR dot
// + current track when online, or a muted "offline" otherwise. Each row probes
// independently and lazily; a dead station just reads offline (failures swallowed).

import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import LiveDot from '@/components/LiveDot';
import { createApi } from '@/lib/api';
import { useTheme } from '@/theme/ThemeContext';

const POLL_MS = 30_000;

interface Live {
  online: boolean;
  track?: string;
}

export default function StationLiveStatus({ url }: { url: string }) {
  const { colors } = useTheme();
  const [live, setLive] = useState<Live | null>(null);

  useEffect(() => {
    let alive = true;
    const api = createApi(url);
    const ctrl = new AbortController();

    const probe = async () => {
      try {
        const np = await api.nowPlaying(ctrl.signal);
        if (!alive) return;
        const online = np.streamOnline !== false; // absent → assume up (controller answered)
        const t = np.nowPlaying;
        const track = t ? [t.artist, t.title].filter(Boolean).join(' — ') : undefined;
        setLive({ online, track: track || undefined });
      } catch {
        if (alive) setLive({ online: false });
      }
    };

    probe();
    const id = setInterval(probe, POLL_MS);
    return () => {
      alive = false;
      ctrl.abort();
      clearInterval(id);
    };
  }, [url]);

  const online = live?.online === true;
  const label = live == null ? '' : online ? (live.track ? `on air · ${live.track}` : 'on air') : 'offline';

  return (
    <View className="flex-row items-center" style={{ gap: 8, minWidth: 0, flexShrink: 1 }}>
      <LiveDot size={6} off={!online} />
      {label ? (
        <Text
          className="font-mono"
          style={{
            fontSize: 9,
            letterSpacing: 1.4,
            textTransform: 'uppercase',
            fontWeight: '700',
            color: online ? colors.accent : colors.muted,
            flexShrink: 1,
          }}
          numberOfLines={1}
        >
          {label}
        </Text>
      ) : null}
    </View>
  );
}
