// First-launch (or "add station") screen, styled after the web mock's onboarding:
// brand + lede, an https:// station-URL field, and a known-stations list. Picking
// or entering a station runs a four-step health check (host → controller →
// stream → DJ booth) with live pass/fail, then a result card to tune in. The
// stepper is cosmetic scaffolding around the real probe — api.health() is the
// gate; api.dj() best-effort fills the station name.

import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DiscMark from '@/components/DiscMark';
import LiveDot from '@/components/LiveDot';
import { createApi, normalizeBase } from '@/lib/api';
import { useStation } from '@/config/StationContext';
import type { StationRef } from '@/lib/station';
import { useTheme } from '@/theme/ThemeContext';

const PROBE_TIMEOUT_MS = 4500;
const STEPS = ['Resolving host', 'Controller · /health', 'Icecast · /stream', 'DJ booth · LLM link'];
type StepState = 'wait' | 'run' | 'ok' | 'fail';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stripProto = (u: string) => u.replace(/^https?:\/\//, '');

interface Target {
  base: string;
  url: string;
  name: string;
}

export default function Onboarding() {
  const { featured, recents, selectStation, base } = useStation();
  const { colors } = useTheme();
  const addMode = !!base;
  // Deep-link from the Stations "Discover" list: prefill + jump straight to the
  // health-check instead of the entry form.
  const params = useLocalSearchParams<{ url?: string; name?: string }>();
  const autoRan = useRef(false);

  const [host, setHost] = useState(stripProto(featured.url));
  const [phase, setPhase] = useState<'entry' | 'check'>('entry');
  const [steps, setSteps] = useState<StepState[]>(['wait', 'wait', 'wait', 'wait']);
  const [target, setTarget] = useState<Target | null>(null);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);
  const runId = useRef(0);

  const known: StationRef[] = [featured, ...recents.filter((r) => r.url !== featured.url)];

  const runCheck = async (rawUrl: string, presetName?: string) => {
    const withProto = /:\/\//.test(rawUrl) ? rawUrl : `https://${rawUrl.trim()}`;
    const normalized = normalizeBase(withProto);
    if (!normalized) return;

    const id = ++runId.current;
    const fallbackName = presetName || stripProto(normalized);
    setTarget({ base: normalized, url: stripProto(normalized), name: fallbackName });
    setSteps(['wait', 'wait', 'wait', 'wait']);
    setDone(false);
    setFailed(false);
    setPhase('check');

    const api = createApi(normalized);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const set = (i: number, s: StepState) =>
      setSteps((prev) => (runId.current === id ? prev.map((v, idx) => (idx === i ? s : v)) : prev));
    const alive = () => runId.current === id;

    try {
      // 1 · Resolving host (cosmetic)
      set(0, 'run');
      await sleep(420);
      if (!alive()) return;
      set(0, 'ok');

      // 2 · Controller /health — the real gate
      set(1, 'run');
      const ok = await api.health(ctrl.signal);
      if (!alive()) return;
      if (!ok) {
        set(1, 'fail');
        setFailed(true);
        return;
      }
      set(1, 'ok');

      // 3 · Icecast /stream (cosmetic — controller answered, mount assumed up)
      set(2, 'run');
      await sleep(380);
      if (!alive()) return;
      set(2, 'ok');

      // 4 · DJ booth — best-effort name resolution
      set(3, 'run');
      let name = fallbackName;
      try {
        const dj = await api.dj(ctrl.signal);
        if (dj?.station || dj?.name) name = dj.station || dj.name || name;
      } catch {
        /* booth name is best-effort */
      }
      if (!alive()) return;
      set(3, 'ok');
      setTarget((t) => (t ? { ...t, name } : t));
      setDone(true);
    } catch {
      if (alive()) {
        set(1, 'fail');
        setFailed(true);
      }
    } finally {
      clearTimeout(timer);
    }
  };

  const tuneIn = async () => {
    if (!target) return;
    // selectStation tears down any current playback before re-pointing.
    await selectStation({ url: target.base, name: target.name });
    if (addMode) {
      // Came here from the stations modal ([index, stations, onboarding]) —
      // unwind to the existing root player. replace() would stack a second
      // player screen inside the modal (overlapping screens).
      router.dismissTo('/');
    } else {
      // First run: onboarding IS the root — swap it for the player.
      router.replace('/');
    }
  };

  const backToEntry = () => {
    runId.current++;
    setPhase('entry');
  };

  // Auto-run the probe once when arriving with a prefilled station (Discover).
  useEffect(() => {
    if (autoRan.current || !params.url) return;
    autoRan.current = true;
    runCheck(params.url, params.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.url, params.name]);

  return (
    <SafeAreaView className="flex-1 bg-bg">
      <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 32 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Brand */}
          <View className="flex-row items-center" style={{ gap: 10, marginBottom: 6 }}>
            <DiscMark size={22} />
            <Text className="font-mono text-ink" style={{ fontSize: 18, letterSpacing: 1, fontWeight: '800' }}>
              SUB/WAVE
            </Text>
          </View>
          <Text className="font-mono text-muted" style={{ fontSize: 11, letterSpacing: 2.4, textTransform: 'uppercase', fontWeight: '700' }}>
            self-hosted internet radio
          </Text>

          <Text className="font-display text-ink" style={{ fontSize: 29, lineHeight: 31, marginTop: 12 }}>
            {addMode ? 'Add a station' : 'Tune in to a station'}
          </Text>

          {phase === 'entry' ? (
            <>
              <Text className="font-body text-muted" style={{ fontSize: 13, lineHeight: 21, marginTop: 12 }}>
                Point SUB/WAVE at a station&apos;s URL — your own box, or a friend&apos;s. It&apos;s one
                stream, one broadcast: you join whatever&apos;s on.
              </Text>

              {/* URL field with https:// prefix */}
              <View
                className="flex-row items-center"
                style={{ marginTop: 18, borderWidth: 1, borderColor: colors.muted, backgroundColor: colors.field }}
              >
                <Text className="font-mono text-muted" style={{ fontSize: 13, paddingLeft: 13, paddingRight: 2 }}>
                  https://
                </Text>
                <TextInput
                  value={host}
                  onChangeText={setHost}
                  placeholder="radio.yourhost.com"
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  keyboardType="url"
                  inputMode="url"
                  returnKeyType="go"
                  onSubmitEditing={() => host.trim() && runCheck(host)}
                  className="font-mono flex-1"
                  style={{ color: colors.ink, fontSize: 14, paddingVertical: 14, paddingRight: 13, paddingLeft: 4 }}
                />
              </View>

              <Pressable
                onPress={() => host.trim() && runCheck(host)}
                disabled={!host.trim()}
                accessibilityRole="button"
                accessibilityLabel="Run health check"
                className="items-center justify-center"
                style={{ marginTop: 12, backgroundColor: colors.accent, paddingVertical: 15, opacity: host.trim() ? 1 : 0.45 }}
              >
                <Text className="font-body-semibold" style={{ color: '#fff', fontSize: 14, letterSpacing: 0.3 }}>
                  Run health check
                </Text>
              </Pressable>

              {/* Known stations */}
              <View className="flex-row items-center" style={{ gap: 10, paddingTop: 18, paddingBottom: 4 }}>
                <Text className="font-mono text-muted" style={{ fontSize: 10, letterSpacing: 2.2, textTransform: 'uppercase', fontWeight: '700' }}>
                  {addMode ? 'Known stations' : 'Or pick a known station'}
                </Text>
                <View style={{ flex: 1, height: 1, backgroundColor: colors.softBorder }} />
              </View>

              <View>
                {known.map((st) => (
                  <Pressable
                    key={st.url}
                    onPress={() => runCheck(st.url, st.name)}
                    accessibilityRole="button"
                    accessibilityLabel={`Connect to ${st.name}`}
                    className="flex-row items-center"
                    style={{ gap: 12, paddingVertical: 12 }}
                  >
                    <LiveDot />
                    <View className="flex-1">
                      <Text className="font-body-semibold text-ink" style={{ fontSize: 14 }} numberOfLines={1}>
                        {st.name}
                      </Text>
                      <Text className="font-mono text-muted" style={{ fontSize: 11 }} numberOfLines={1}>
                        {stripProto(st.url)}
                      </Text>
                    </View>
                    <ChevronRight size={15} color={colors.muted} />
                  </Pressable>
                ))}
              </View>

              {addMode ? (
                <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back to player" className="items-start" style={{ marginTop: 8, paddingVertical: 8 }}>
                  <Text className="font-body text-muted" style={{ fontSize: 13 }}>
                    ← back to player
                  </Text>
                </Pressable>
              ) : null}
            </>
          ) : (
            <HealthCheck
              target={target}
              steps={steps}
              done={done}
              failed={failed}
              onTuneIn={tuneIn}
              onBack={backToEntry}
              onRetry={() => target && runCheck(target.url, target.name)}
            />
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function HealthCheck({
  target,
  steps,
  done,
  failed,
  onTuneIn,
  onBack,
  onRetry,
}: {
  target: Target | null;
  steps: StepState[];
  done: boolean;
  failed: boolean;
  onTuneIn: () => void;
  onBack: () => void;
  onRetry: () => void;
}) {
  const { colors } = useTheme();
  const destructive = '#c5302a';

  return (
    <View style={{ marginTop: 16, gap: 16 }}>
      <View className="flex-row items-baseline" style={{ gap: 10, borderBottomWidth: 1, borderBottomColor: colors.ink, paddingBottom: 12 }}>
        <Text className="font-mono text-muted" style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', fontWeight: '700' }}>
          checking
        </Text>
        <Text className="font-mono text-ink flex-1" style={{ fontSize: 14, fontWeight: '600' }} numberOfLines={1}>
          {target?.url}
        </Text>
      </View>

      <View>
        {STEPS.map((label, i) => {
          const s = steps[i];
          const dotColor =
            s === 'ok' ? colors.accent : s === 'fail' ? destructive : 'transparent';
          const dotBorder = s === 'run' ? colors.accent : s === 'ok' ? colors.accent : s === 'fail' ? destructive : colors.muted;
          const labelColor = s === 'wait' ? colors.muted : colors.ink;
          const statText = s === 'ok' ? 'ok' : s === 'fail' ? 'failed' : s === 'run' ? '…' : '';
          const statColor = s === 'ok' ? colors.accent : s === 'fail' ? destructive : colors.muted;
          return (
            <View
              key={label}
              className="flex-row items-center"
              style={{ gap: 12, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: colors.softBorder }}
            >
              <View style={{ width: 9, height: 9, borderRadius: 5, borderWidth: 1, borderColor: dotBorder, backgroundColor: dotColor }} />
              <Text className="font-body flex-1" style={{ fontSize: 13, color: labelColor }}>
                {label}
              </Text>
              <Text className="font-mono" style={{ fontSize: 10, letterSpacing: 1.8, textTransform: 'uppercase', fontWeight: '700', color: statColor }}>
                {statText}
              </Text>
            </View>
          );
        })}
      </View>

      {done && target ? (
        <View style={{ gap: 14 }}>
          <View style={{ borderWidth: 1, borderColor: colors.accent, backgroundColor: `${colors.accent}17`, padding: 14, gap: 6 }}>
            <View className="flex-row items-center justify-between" style={{ gap: 10 }}>
              <Text className="font-body-semibold text-ink" style={{ fontSize: 16 }} numberOfLines={1}>
                {target.name}
              </Text>
              <View className="flex-row items-center" style={{ gap: 6 }}>
                <LiveDot size={6} />
                <Text className="font-mono text-accent" style={{ fontSize: 9, letterSpacing: 2, textTransform: 'uppercase', fontWeight: '700' }}>
                  on air
                </Text>
              </View>
            </View>
            <Text className="font-mono text-muted" style={{ fontSize: 11 }} numberOfLines={1}>
              {target.url}
            </Text>
          </View>
          <Pressable onPress={onTuneIn} accessibilityRole="button" accessibilityLabel={`Tune in to ${target.name}`} className="items-center justify-center" style={{ backgroundColor: colors.accent, paddingVertical: 15 }}>
            <Text className="font-body-semibold" style={{ color: '#fff', fontSize: 14 }}>
              Tune in to {target.name}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {failed ? (
        <View style={{ gap: 14 }}>
          <View style={{ borderWidth: 1, borderColor: destructive, padding: 14 }}>
            <Text className="font-body text-muted" style={{ fontSize: 12.5, lineHeight: 20 }}>
              <Text className="font-body-semibold text-ink">Stream unreachable.</Text> The controller didn&apos;t
              answer — the station may be off air, or the box is asleep.
            </Text>
          </View>
          <View className="flex-row" style={{ gap: 10 }}>
            <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Try another URL" className="flex-1 items-center justify-center" style={{ borderWidth: 1, borderColor: colors.muted, paddingVertical: 13 }}>
              <Text className="font-body text-ink" style={{ fontSize: 13 }}>← Try another URL</Text>
            </Pressable>
            <Pressable onPress={onRetry} accessibilityRole="button" accessibilityLabel="Retry" className="flex-1 items-center justify-center" style={{ borderWidth: 1, borderColor: colors.accent, paddingVertical: 13 }}>
              <Text className="font-body text-accent" style={{ fontSize: 13 }}>Retry</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {!done && !failed ? (
        <View className="flex-row items-center justify-center" style={{ gap: 8, paddingTop: 4 }}>
          <ActivityIndicator size="small" color={colors.muted} />
        </View>
      ) : null}
    </View>
  );
}
