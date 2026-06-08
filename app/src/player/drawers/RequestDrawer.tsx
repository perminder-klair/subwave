// Listener request slip: write a note to the booth, optional name, context-aware
// suggestion chips, then submit + poll for the outcome. Ported from web
// RequestDrawer — same constants, suggestions, and polling cadence, but it owns
// its own submit/poll via the station API instead of threaded callbacks.

import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { ArrowUpRight, Radio } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import type { StationApi } from '@/lib/api';
import type { NowPlayingTrack, RequestResult, StationContext } from '@/lib/types';
import { useTheme } from '@/theme/ThemeContext';

const SUCCESS_HOLD_MS = 2800;
const POLL_INTERVAL_MS = 1500;
const POLL_DEADLINE_MS = 60000;

function templatedAck(name: string): string {
  const n = name.trim();
  return n ? `Got it, ${n} — taking it to the booth.` : `Got it — taking it to the booth.`;
}

interface Suggestion {
  text: string;
  attribution: string;
}

function buildSuggestions(
  nowPlaying: NowPlayingTrack | null,
  context: StationContext | null,
): Suggestion[] {
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  const push = (text: string, attribution: string) => {
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text, attribution });
  };
  if (nowPlaying?.artist) push('more like this', `more ${nowPlaying.artist}`);
  const festival = context?.festival?.name;
  if (festival) push(`${festival.toLowerCase()} mood`, 'festival');
  const vibe = context?.time?.vibe || context?.time?.show;
  if (vibe) push(`${vibe} vibes`, 'right now');
  const cond = context?.weather?.condition;
  const weatherMap: Record<string, string> = {
    clear: 'sunny afternoon', sunny: 'sunny afternoon', cloudy: 'overcast mood',
    rain: 'rainy day', rainy: 'rainy day', drizzle: 'rainy day',
    snow: 'snowy night', snowy: 'snowy night', fog: 'foggy morning',
    foggy: 'foggy morning', thunderstorm: 'stormy night',
  };
  if (cond && cond !== 'unknown') push(weatherMap[cond] || `${cond} day`, 'weather');
  push('surprise me', 'random');
  return out.slice(0, 5);
}

export interface RequestDrawerProps {
  api: StationApi;
  nowPlaying: NowPlayingTrack | null;
  context: StationContext | null;
  onClose: () => void;
}

export default function RequestDrawer({ api, nowPlaying, context, onClose }: RequestDrawerProps) {
  const { colors } = useTheme();
  const [requestText, setRequestText] = useState('');
  const [requesterName, setRequesterName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<RequestResult | null>(null);

  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollStop = useRef(false);

  useEffect(
    () => () => {
      pollStop.current = true;
      if (closeTimer.current) clearTimeout(closeTimer.current);
      if (pollTimer.current) clearTimeout(pollTimer.current);
    },
    [],
  );

  const chips = useMemo(
    () => buildSuggestions(nowPlaying, context),
    [nowPlaying?.artist, context?.festival?.name, context?.time?.vibe, context?.time?.show, context?.weather?.condition],
  );

  const scheduleClose = () => {
    if (closeTimer.current) return;
    closeTimer.current = setTimeout(() => {
      onClose();
      setTimeout(() => setResult(null), 300);
    }, SUCCESS_HOLD_MS);
  };

  const startPolling = (requestId: string) => {
    pollStop.current = false;
    const deadline = Date.now() + POLL_DEADLINE_MS;
    const tick = async () => {
      if (pollStop.current) return;
      if (Date.now() > deadline) { scheduleClose(); return; }
      let data: RequestResult | null = null;
      try {
        data = await api.pollRequest(requestId);
      } catch {
        data = null;
      }
      if (pollStop.current) return;
      if (data?.status === 'resolved') {
        setResult((prev) => ({
          success: true,
          ack: data!.ack || prev?.ack,
          track: data!.track,
          queuePosition: data!.queuePosition,
        }));
        scheduleClose();
        return;
      }
      if (data?.status === 'failed') {
        setResult({ success: false, message: data.message || 'No match — try different words.' });
        return;
      }
      if (data?.status === 'unknown') { scheduleClose(); return; }
      pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
    };
    pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
  };

  const handleSubmit = async () => {
    const askedText = requestText.trim();
    const askedName = requesterName.trim();
    if (!askedText || isSubmitting) return;
    setIsSubmitting(true);
    let data: RequestResult | null = null;
    try {
      data = await api.postRequest({ text: askedText, name: askedName });
    } catch {
      data = { success: false, message: 'Request failed. Is the station up?' };
    } finally {
      setIsSubmitting(false);
    }
    if (!data) return;
    if (!data.success) {
      setResult(data);
      return;
    }
    setRequestText('');
    setResult({ success: true, pending: true, ack: templatedAck(askedName), requestText: askedText });
    if (data.requestId) startPolling(data.requestId);
    else scheduleClose();
  };

  if (result?.success) return <SuccessCard result={result} />;

  const canSend = !isSubmitting && !!requestText.trim();

  return (
    <View>
      <View style={{ borderWidth: 1, borderColor: colors.ink, backgroundColor: `${colors.field}66` }}>
        <View
          className="flex-row items-center justify-between"
          style={{ paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.ink }}
        >
          <View className="flex-row items-center" style={{ gap: 8 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent }} />
            <Text className="font-mono text-ink" style={{ fontSize: 9, letterSpacing: 3 }}>LINE OPEN</Text>
          </View>
          <View className="flex-row items-center" style={{ gap: 6 }}>
            <Radio size={11} color={colors.muted} />
            <Text className="font-mono text-muted" style={{ fontSize: 9, letterSpacing: 3 }}>REQUEST SLIP</Text>
          </View>
        </View>

        <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 14 }}>
          <Text className="font-mono text-muted" style={{ fontSize: 9, letterSpacing: 3, marginBottom: 8 }}>
            DEAR DJ —
          </Text>
          <View style={{ borderLeftWidth: 2, borderLeftColor: colors.accent, paddingLeft: 12 }}>
            <BottomSheetTextInput
              value={requestText}
              onChangeText={(t) => { setRequestText(t); if (result) setResult(null); }}
              placeholder={'play me something for late-night driving…'}
              placeholderTextColor={colors.muted}
              multiline
              style={{
                fontFamily: 'Fraunces_400Regular',
                fontSize: 16,
                lineHeight: 26,
                color: colors.ink,
                fontStyle: 'italic',
                minHeight: 78,
              }}
            />
          </View>

          <View
            className="flex-row items-baseline mt-3"
            style={{ gap: 8, borderTopWidth: 1, borderTopColor: colors.softBorder, paddingTop: 12 }}
          >
            <Text style={{ fontFamily: 'Fraunces_400Regular', fontSize: 15, color: colors.muted, fontStyle: 'italic' }}>—</Text>
            <BottomSheetTextInput
              value={requesterName}
              onChangeText={setRequesterName}
              placeholder="signed, your name (optional)"
              placeholderTextColor={colors.muted}
              style={{ flex: 1, fontFamily: 'JetBrainsMono_400Regular', fontSize: 12, color: colors.ink }}
            />
          </View>
        </View>
      </View>

      <Text className="font-body text-muted mt-3" style={{ fontSize: 11, lineHeight: 18 }}>
        Describe a mood, a memory, an artist. The agentic AI DJ reads your note, digs the library,
        and answers you on-air.
      </Text>

      <View className="mt-4">
        <Text className="font-mono text-muted" style={{ fontSize: 9, letterSpacing: 3, marginBottom: 8 }}>ON THE WIRE</Text>
        <View className="flex-row flex-wrap" style={{ gap: 6 }}>
          {chips.map((chip) => (
            <Pressable
              key={chip.text}
              onPress={() => setRequestText(chip.text)}
              style={{ borderWidth: 1, borderColor: colors.ink, paddingHorizontal: 12, paddingVertical: 6 }}
            >
              <Text className="text-ink" style={{ fontSize: 11, letterSpacing: 0.5 }}>{chip.text}</Text>
              <Text className="font-mono text-muted" style={{ fontSize: 8, letterSpacing: 2, marginTop: 3 }}>
                {chip.attribution.toUpperCase()}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {result && !result.success ? (
        <View style={{ marginTop: 12, borderWidth: 1, borderColor: '#c0392b', backgroundColor: 'rgba(192,57,43,0.06)', paddingHorizontal: 12, paddingVertical: 10 }}>
          <Text style={{ color: '#c0392b', fontSize: 12 }}>{result.message || 'No match — try different words.'}</Text>
        </View>
      ) : null}

      <Pressable
        onPress={handleSubmit}
        disabled={!canSend}
        className="flex-row items-center justify-center mt-4"
        style={{ backgroundColor: colors.accent, paddingVertical: 14, gap: 10, opacity: canSend ? 1 : 0.5 }}
      >
        {isSubmitting ? (
          <ActivityIndicator color={colors.bg} />
        ) : (
          <>
            <Text className="font-body-semibold" style={{ color: colors.bg, fontSize: 13, letterSpacing: 1.5 }}>
              SEND TO THE BOOTH
            </Text>
            <ArrowUpRight size={16} color={colors.bg} strokeWidth={2.25} />
          </>
        )}
      </Pressable>
    </View>
  );
}

function SuccessCard({ result }: { result: RequestResult }) {
  const { colors } = useTheme();
  const { ack, track, queuePosition, pending, requestText } = result;
  return (
    <View style={{ paddingVertical: 8 }}>
      <View className="flex-row items-center" style={{ gap: 8, marginBottom: 14 }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent }} />
        <Text className="font-mono text-accent" style={{ fontSize: 9, letterSpacing: 4 }}>
          {pending ? 'ON THE WIRE' : 'QUEUED'}
        </Text>
      </View>

      {ack ? (
        <Text
          style={{
            fontFamily: 'Fraunces_400Regular',
            fontSize: 18,
            lineHeight: 26,
            fontStyle: 'italic',
            color: colors.ink,
            borderLeftWidth: 2,
            borderLeftColor: colors.accent,
            paddingLeft: 14,
            marginBottom: 22,
          }}
        >
          “{ack}”
        </Text>
      ) : null}

      <View style={{ borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.softBorder, paddingVertical: 16 }}>
        <Text className="font-mono text-muted" style={{ fontSize: 9, letterSpacing: 3, marginBottom: 6 }}>
          {pending ? 'THE DJ IS DIGGING' : 'NOW IN THE BOOTH'}
        </Text>
        {pending ? (
          <>
            <Text style={{ fontFamily: 'Fraunces_400Regular', fontSize: 16, fontStyle: 'italic', color: colors.ink }}>
              finding your track…
            </Text>
            {requestText ? (
              <Text className="font-body text-muted mt-1" style={{ fontSize: 13 }}>“{requestText}”</Text>
            ) : null}
          </>
        ) : (
          <>
            <Text className="font-body-semibold text-ink" style={{ fontSize: 22 }}>{track?.title}</Text>
            <Text className="font-body text-muted mt-0.5" style={{ fontSize: 13 }}>{track?.artist}</Text>
          </>
        )}
      </View>

      {!pending && typeof queuePosition === 'number' && queuePosition > 0 ? (
        <Text className="font-mono text-muted mt-4" style={{ fontSize: 11, letterSpacing: 1 }}>
          POSITION #{queuePosition} IN QUEUE
        </Text>
      ) : null}

      <Text className="font-mono text-muted mt-6" style={{ fontSize: 10, letterSpacing: 3 }}>
        {pending ? 'YOU CAN CLOSE THIS — YOUR REQUEST IS LOCKED IN' : 'CLOSING…'}
      </Text>
    </View>
  );
}
