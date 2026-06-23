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
import { ArrowLeftRight, ChevronRight } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DiscMark from '@/components/DiscMark';
import LiveDot from '@/components/LiveDot';
import StationLiveStatus from '@/components/StationLiveStatus';
import { createApi, normalizeBase, type HealthResult, type StationApi } from '@/lib/api';
import { useStation } from '@/config/StationContext';
import { fetchDirectory, type DirectoryStation } from '@/lib/directory';
import type { StationRef } from '@/lib/station';
import { useTheme } from '@/theme/ThemeContext';

const PROBE_TIMEOUT_MS = 4500;
const STEPS = ['Resolving host', 'Controller · /health', 'Icecast · /stream', 'DJ booth · LLM link'];
type StepState = 'wait' | 'run' | 'ok' | 'fail';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stripProto = (u: string) => u.replace(/^https?:\/\//, '');
// Bare host (no scheme, port, or path), lowercased. Best-effort for hostnames
// and IPv4 — an IPv6 literal isn't a realistic station address here.
const hostOf = (u: string) => stripProto(u).split('/')[0].split(':')[0].toLowerCase();
// Private/reserved TLDs that never resolve on the public internet, so a
// cleartext station behind one is a LAN box, not an exposed origin.
const PRIVATE_TLDS = /\.(local|lan|home|internal|corp|intranet|localdomain)$|\.home\.arpa$/;
// A host where falling back to cleartext carries bounded MITM risk: loopback, a
// single-label LAN name (http://nas), *.local mDNS, an RFC1918 address, or a
// private TLD. These skip the insecure-downgrade consent prompt. Anything that
// looks like a public domain does NOT — it takes the one-tap consent path.
const isLocalHost = (h: string) =>
  h === 'localhost' ||
  !h.includes('.') ||
  PRIVATE_TLDS.test(h) ||
  /^127\./.test(h) ||
  /^10\./.test(h) ||
  /^192\.168\./.test(h) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(h);

// Cleartext-warning / http-scheme accent. Mirrors HealthCheck's local copy.
const DANGER = '#c5302a';

// Recognise a TLS "the server's CA isn't trusted" failure from the raw error
// (Android: "Trust anchor for certification path not found" /
// CertPathValidatorException; iOS: certificate invalid / not trusted). The app
// trusts user-installed CAs (see plugins/withAndroidUserCaTrust.js), so when
// this still fires the CA simply isn't installed/trusted on THIS device.
const isUntrustedCa = (msg?: string) =>
  !!msg && /trust anchor|certpathvalidator|certification path|certificate.*(invalid|not trusted)/i.test(msg);

// Turn a failed health probe into a human diagnostic for the failure card. The
// network case names the usual "works in the browser, fails in the app" culprit
// (a TLS chain Android rejects but the browser tolerates) — the most common and
// least obvious cause for an otherwise-valid HTTPS station.
function describeFail(fail: HealthResult | null, candidates: string[]): string | undefined {
  if (!fail || fail.ok) return undefined;
  if (fail.kind === 'timeout')
    return 'No response in time — the box may be asleep, on another network, or blocked by a firewall.';
  if (fail.kind === 'http')
    return `The server answered with HTTP ${fail.status ?? '?'}, so the address is reachable but the request never reached the controller. Check that your reverse proxy routes /api/* to the controller on port 7701.`;
  // The device doesn't trust the station's cert. Two real-world causes, same
  // error: (1) a public chain whose root is too NEW for an older phone's trust
  // store — fixed server-side by serving a cross-signed intermediate back to an
  // older trusted root (issue #458: Sectigo R46 unknown to Android 12); or (2) a
  // private/self-signed CA. The app trusts user-installed CAs
  // (plugins/withAndroidUserCaTrust.js), so installing the root on the device
  // also works for either case.
  if (isUntrustedCa(fail.message)) {
    const install =
      Platform.OS === 'ios'
        ? 'install its root on the device, then enable it under Settings → General → About → Certificate Trust Settings'
        : 'install its root on the device (Settings → Security → Encryption & credentials → Install a certificate → CA certificate)';
    return `This device doesn't trust the station's certificate. On older phones this is usually a chain ending at a root too new for the device — set your reverse proxy to serve the full chain, including any cross-signed intermediate that links back to an older trusted root. If it's a private or self-signed CA, ${install} instead. A publicly-trusted certificate (e.g. Let's Encrypt) or plain http:// on your LAN also work.`;
  }
  const triedHttps = candidates.some((c) => c.startsWith('https://'));
  return triedHttps
    ? "Couldn't open a connection. If the same address works in your phone's browser, it's usually a TLS/certificate the app rejects but the browser tolerates — most often an incomplete certificate chain (set your reverse proxy to serve the full chain, including intermediates) or a private/self-signed CA the device doesn't trust. DNS or a firewall on this network can cause it too."
    : "Couldn't open a connection — check the address is right and the station is reachable from this network.";
}

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
  // True when the resolved station is cleartext http on a non-local host —
  // gates "Tune in" behind an explicit consent button.
  const [insecure, setInsecure] = useState(false);
  // Scheme for the manual entry field. https is the friendly default (a bare
  // host still auto-falls back to http); switching to http forces cleartext for
  // HTTP-only boxes. An explicit scheme typed into the field always wins.
  const [scheme, setScheme] = useState<'https' | 'http'>('https');
  // Diagnostic + raw error for the failure card, set by runCheck on a dead probe.
  const [failDetail, setFailDetail] = useState<string | undefined>(undefined);
  const [failRaw, setFailRaw] = useState<string | undefined>(undefined);
  const [directory, setDirectory] = useState<DirectoryStation[]>([]);
  const runId = useRef(0);

  // Pull the community directory so a fresh installer can browse beyond the
  // bundled featured station — same source the Stations switcher discovers from.
  useEffect(() => {
    const ctrl = new AbortController();
    fetchDirectory(ctrl.signal).then((list) => setDirectory(list));
    return () => ctrl.abort();
  }, []);

  const known: StationRef[] = [featured, ...recents.filter((r) => r.url !== featured.url)];

  // Discover = directory minus anything already in the known list, minus dupes.
  const knownKeys = new Set(known.map((r) => normalizeBase(r.url)));
  const discoverRows = directory.filter((st) => {
    const k = normalizeBase(st.url);
    if (knownKeys.has(k)) return false;
    knownKeys.add(k);
    return true;
  });

  const runCheck = async (rawUrl: string, presetName?: string) => {
    const trimmed = rawUrl.trim();
    // A bare hostname probes https first then falls back to cleartext http, so
    // listeners on HTTP-only stations can just type the address. An explicit
    // protocol (http:// or https://) is honored verbatim — no fallback.
    const candidates = (/:\/\//.test(trimmed) ? [trimmed] : [`https://${trimmed}`, `http://${trimmed}`])
      .map((c) => normalizeBase(c))
      .filter(Boolean);
    if (!candidates.length) return;

    const id = ++runId.current;
    const first = candidates[0];
    setTarget({ base: first, url: stripProto(first), name: presetName || stripProto(first) });
    setSteps(['wait', 'wait', 'wait', 'wait']);
    setDone(false);
    setFailed(false);
    setInsecure(false);
    setFailDetail(undefined);
    setFailRaw(undefined);
    setPhase('check');

    const set = (i: number, s: StepState) =>
      setSteps((prev) => (runId.current === id ? prev.map((v, idx) => (idx === i ? s : v)) : prev));
    const alive = () => runId.current === id;

    // Hit one candidate's controller /health behind its own timeout. Returns
    // the live StationApi on success, or a structured failure (timeout / http /
    // network) so the caller can try the next candidate and, if all fail, show
    // a real diagnostic instead of a bare "failed".
    const probe = async (candidate: string): Promise<{ api: StationApi } | { fail: HealthResult }> => {
      const api = createApi(candidate);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      try {
        const r = await api.probeHealth(ctrl.signal);
        return r.ok ? { api } : { fail: r };
      } catch (e) {
        const err = e as { message?: string };
        return { fail: { ok: false, kind: 'network', message: err?.message } };
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      // 1 · Resolving host (cosmetic)
      set(0, 'run');
      await sleep(420);
      if (!alive()) return;
      set(0, 'ok');

      // 2 · Controller /health — the real gate. Try each candidate in turn.
      set(1, 'run');
      let api: StationApi | null = null;
      let base = first;
      let lastFail: HealthResult | null = null;
      for (const candidate of candidates) {
        base = candidate;
        const r = await probe(candidate);
        if (!alive()) return;
        if ('api' in r) {
          api = r.api;
          break;
        } else {
          lastFail = r.fail;
        }
      }
      if (!api) {
        set(1, 'fail');
        setFailDetail(describeFail(lastFail, candidates));
        const raw = lastFail && !lastFail.ok ? lastFail.message : undefined;
        // The Android generic carries no detail; iOS often surfaces a useful one.
        setFailRaw(raw && raw !== 'Network request failed' ? raw : undefined);
        setFailed(true);
        return;
      }
      // Re-point the target at the candidate that actually answered.
      const fallbackName = presetName || stripProto(base);
      setTarget({ base, url: stripProto(base), name: fallbackName });
      // Flag cleartext on a non-local host — whether the probe silently fell
      // back from https (an on-path attacker could force that by blocking the
      // https attempt) or the listener picked http explicitly. Either way a
      // public-looking host over plain HTTP needs one-tap consent; local hosts
      // carry bounded risk and skip it.
      setInsecure(base.startsWith('http://') && !isLocalHost(hostOf(base)));
      set(1, 'ok');

      // 3 · Icecast /stream (cosmetic — controller answered, mount assumed up)
      set(2, 'run');
      await sleep(380);
      if (!alive()) return;
      set(2, 'ok');

      // 4 · DJ booth — best-effort name resolution
      set(3, 'run');
      let name = fallbackName;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      try {
        const dj = await api.dj(ctrl.signal);
        if (dj?.station || dj?.name) name = dj.station || dj.name || name;
      } catch {
        /* booth name is best-effort */
      } finally {
        clearTimeout(timer);
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

  // Manual-entry submit. An explicit scheme typed into the field wins; otherwise
  // https keeps the bare-host auto-fallback (https→http) and http forces cleartext.
  const submitEntry = () => {
    const h = host.trim();
    if (!h) return;
    if (/:\/\//.test(h)) runCheck(h);
    else runCheck(scheme === 'http' ? `http://${h}` : h);
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

              {/* URL field with a tappable scheme toggle (https ⇄ http) */}
              <View
                className="flex-row items-center"
                style={{ marginTop: 18, borderWidth: 1, borderColor: colors.muted, backgroundColor: colors.field }}
              >
                <Pressable
                  onPress={() => setScheme((s) => (s === 'https' ? 'http' : 'https'))}
                  accessibilityRole="button"
                  accessibilityLabel={`Connection scheme ${scheme}. Tap to switch to ${scheme === 'https' ? 'HTTP' : 'HTTPS'}.`}
                  hitSlop={8}
                  className="flex-row items-center"
                  style={{ gap: 5, paddingLeft: 13, paddingRight: 9, paddingVertical: 14, borderRightWidth: 1, borderRightColor: colors.softBorder }}
                >
                  <Text className="font-mono" style={{ fontSize: 13, fontWeight: '700', color: scheme === 'http' ? DANGER : colors.accent }}>
                    {scheme}://
                  </Text>
                  <ArrowLeftRight size={11} color={colors.muted} />
                </Pressable>
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
                  onSubmitEditing={submitEntry}
                  className="font-mono flex-1"
                  style={{ color: colors.ink, fontSize: 14, paddingVertical: 14, paddingRight: 13, paddingLeft: 10 }}
                />
              </View>
              {/* HTTPS is tried first for a bare host and falls back to HTTP; tap
                  the prefix to force one or the other. */}
              <Text className="font-mono text-muted" style={{ fontSize: 10.5, lineHeight: 16, marginTop: 7 }}>
                Tap the prefix to switch HTTPS / HTTP. HTTPS auto-falls back to HTTP.
              </Text>

              <Pressable
                onPress={submitEntry}
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

              {/* Discover — community directory stations not already listed above */}
              {discoverRows.length ? (
                <>
                  <View className="flex-row items-center" style={{ gap: 10, paddingTop: 18, paddingBottom: 4 }}>
                    <Text className="font-mono text-muted" style={{ fontSize: 10, letterSpacing: 2.2, textTransform: 'uppercase', fontWeight: '700' }}>
                      Discover
                    </Text>
                    <View style={{ flex: 1, height: 1, backgroundColor: colors.softBorder }} />
                  </View>
                  <View>
                    {discoverRows.map((st) => {
                      const sub = [st.location, st.genre].filter(Boolean).join(' · ');
                      return (
                        <Pressable
                          key={st.slug || st.url}
                          onPress={() => runCheck(st.url, st.name)}
                          accessibilityRole="button"
                          accessibilityLabel={`Connect to ${st.name}`}
                          className="flex-row items-center"
                          style={{ gap: 12, paddingVertical: 12 }}
                        >
                          <View className="flex-1">
                            <Text className="font-body-semibold text-ink" style={{ fontSize: 14 }} numberOfLines={1}>
                              {st.name}
                            </Text>
                            <Text className="font-mono text-muted" style={{ fontSize: 11 }} numberOfLines={1}>
                              {sub || stripProto(st.url)}
                            </Text>
                            <View style={{ marginTop: 4 }}>
                              <StationLiveStatus url={st.url} />
                            </View>
                          </View>
                          <ChevronRight size={15} color={colors.muted} />
                        </Pressable>
                      );
                    })}
                  </View>
                </>
              ) : null}

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
              insecure={insecure}
              failDetail={failDetail}
              failRaw={failRaw}
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
  insecure,
  failDetail,
  failRaw,
  onTuneIn,
  onBack,
  onRetry,
}: {
  target: Target | null;
  steps: StepState[];
  done: boolean;
  failed: boolean;
  insecure: boolean;
  failDetail?: string;
  failRaw?: string;
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
          {insecure ? (
            <View style={{ borderWidth: 1, borderColor: destructive, padding: 14, gap: 6 }}>
              <Text className="font-body-semibold text-ink" style={{ fontSize: 13 }}>
                Insecure connection
              </Text>
              <Text className="font-body text-muted" style={{ fontSize: 12.5, lineHeight: 20 }}>
                This station answered over plain HTTP, not HTTPS, so anyone on your network can
                see and tamper with the traffic. Only continue if it&apos;s your own box, or a
                station you trust on a network you trust.
              </Text>
            </View>
          ) : null}
          <Pressable
            onPress={onTuneIn}
            accessibilityRole="button"
            accessibilityLabel={insecure ? 'Continue over insecure HTTP' : `Tune in to ${target.name}`}
            className="items-center justify-center"
            style={{ backgroundColor: insecure ? destructive : colors.accent, paddingVertical: 15 }}
          >
            <Text className="font-body-semibold" style={{ color: '#fff', fontSize: 14 }}>
              {insecure ? 'Continue over insecure HTTP' : `Tune in to ${target.name}`}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {failed ? (
        <View style={{ gap: 14 }}>
          <View style={{ borderWidth: 1, borderColor: destructive, padding: 14, gap: 8 }}>
            <Text className="font-body text-muted" style={{ fontSize: 12.5, lineHeight: 20 }}>
              <Text className="font-body-semibold text-ink">Stream unreachable. </Text>
              {failDetail ?? "The controller didn't answer — the station may be off air, or the box is asleep."}
            </Text>
            {failRaw ? (
              <Text className="font-mono text-muted" style={{ fontSize: 10.5, lineHeight: 16 }} numberOfLines={3}>
                {failRaw}
              </Text>
            ) : null}
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
