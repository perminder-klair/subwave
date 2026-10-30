import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import LiveDot from '@/components/LiveDot';
import { useStation } from '@/config/StationContext';
import { liveStatusClient } from '@/lib/live-status';
import { useTheme } from '@/theme/ThemeContext';

const POLL_MS = 30_000;

interface Live {
  online: boolean;
  track?: string;
}

export default function StationLiveStatus({ url }: { url: string }) {
  const { colors } = useTheme();
  const { credentialsFor } = useStation();
  const [live, setLive] = useState<Live | null>(null);

  useEffect(() => {
    let alive = true;
    const client = liveStatusClient(url, credentialsFor);
    const ctrl = new AbortController();

    const probe = async () => {
      try {
        const np = await (await client).nowPlaying(ctrl.signal);
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
  }, [url, credentialsFor]);

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
