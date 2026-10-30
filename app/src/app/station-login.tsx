// Edit a saved station's login (#1873): the HTTP Basic Auth pair a reverse
// proxy may ask for, never SUB/WAVE's own station password (#478), which this
// screen can only forget. A changed login is checked with the station first
// (checkStationLogin): one a proxy refuses is never saved, and one the stream
// password refused or that could not be checked is saved only on "Save
// anyway" (saveAnywayOffered).

import { router, useLocalSearchParams } from 'expo-router';
import { KeyRound, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import LoginFields, { confirmCleartextLogin } from '@/components/LoginFields';
import { useStation } from '@/config/StationContext';
import { createApi, type HealthResult } from '@/lib/api';
import { splitStationAddress, type StationCredentials } from '@/lib/station-credentials';
import { checkStationLogin, saveAnywayOffered, type LoginCheck } from '@/lib/station-login';
import { useTheme } from '@/theme/ThemeContext';

const PROBE_TIMEOUT_MS = 4500;
const DANGER = '#c5302a';
const stripProto = (u: string) => u.replace(/^https?:\/\//, '');

const OUTCOME_COPY: Record<string, string> = {
  proxy: 'The station refused this login, so it was not saved. Check the username and password.',
  'stream-password':
    "The station's password check refused this password, so nothing was saved. A proxy that guards only the stream may still want this login, and the app can't check that: if you're sure it's right, save it anyway.",
  // Also a station that answered, but with something that says nothing about
  // the login (a 403, an unchallenged 401), so never "couldn't reach".
  unreachable: "Couldn't check this login with the station. Save it anyway, or try again later.",
  'rate-limited':
    'The station is limiting password checks right now, so this login could not be checked. Save it anyway, or wait a few minutes and try again.',
};

function outcomeCopy(outcome: LoginCheck): string | null {
  if (outcome.verdict === 'rejected') return OUTCOME_COPY[outcome.by];
  if (outcome.verdict === 'unreachable') {
    return OUTCOME_COPY[outcome.rateLimited ? 'rate-limited' : 'unreachable'];
  }
  return null;
}

const sameLogin = (a: StationCredentials | null, b: StationCredentials | null) =>
  a?.username === b?.username && a?.password === b?.password;

function Divider({ children }: { children: string }) {
  const { colors } = useTheme();
  return (
    <View className="flex-row items-center" style={{ gap: 10, paddingTop: 22, paddingBottom: 8 }}>
      <Text className="font-mono text-muted" style={{ fontSize: 10, letterSpacing: 2.2, textTransform: 'uppercase', fontWeight: '700' }}>
        {children}
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.softBorder }} />
    </View>
  );
}

export default function StationLogin() {
  const params = useLocalSearchParams<{ url?: string; name?: string }>();
  const { credentialsFor, saveLogin, stationPasswordSaved, forgetStationPasswordFor } = useStation();
  const { colors } = useTheme();
  const base = splitStationAddress(params.url ?? '').base;
  const name = params.name || stripProto(base);

  const [loaded, setLoaded] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [saved, setSaved] = useState<StationCredentials | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<LoginCheck | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!base) return;
    let alive = true;
    Promise.all([credentialsFor(base), stationPasswordSaved(base).catch(() => false)]).then(
      ([credentials, passwordSaved]) => {
        if (!alive) return;
        setSaved(credentials);
        setUsername(credentials?.username ?? '');
        setPassword(credentials?.password ?? '');
        setHasPassword(passwordSaved);
        setLoaded('ready');
      },
      () => {
        if (alive) setLoaded('failed');
      },
    );
    return () => {
      alive = false;
    };
  }, [base, credentialsFor, stationPasswordSaved]);

  // Same rule as adding a station: two empty fields are no login.
  const draft: StationCredentials | null = username || password ? { username, password } : null;
  const canSave = loaded === 'ready' && !!draft && !sameLogin(draft, saved) && !busy;

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  // Closing the screen mid-check cancels the save: a late verdict must neither
  // save a login the listener walked away from nor close whatever screen is on
  // top by then (the Stations list, or the player itself).
  const openRef = useRef(true);
  useEffect(() => {
    openRef.current = true;
    return () => {
      openRef.current = false;
    };
  }, []);

  const edit = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    // "Save anyway" answers for the login that was checked, not an edited one.
    setOutcome(null);
    setError(undefined);
  };

  const health = async (login: StationCredentials | null): Promise<HealthResult> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      return await createApi(base, login).probeHealth(ctrl.signal);
    } finally {
      clearTimeout(timer);
    }
  };

  const store = async (login: StationCredentials) => {
    try {
      await saveLogin(base, login);
      if (openRef.current) close();
    } catch {
      setBusy(false);
      setError("Couldn't save this login securely. The saved login was left as it was; unlock the device and try again.");
    }
  };

  const save = async () => {
    if (!canSave || !draft) return;
    setError(undefined);
    setOutcome(null);
    // The check itself sends the login, so ask before it goes out in cleartext.
    if (base.startsWith('http://') && !(await confirmCleartextLogin())) return;
    setBusy(true);
    const api = createApi(base, draft);
    const result = await checkStationLogin({
      login: draft,
      health,
      streamPassword: () =>
        api.state().then(
          (state) => state.privacy?.listenerAuth === true,
          () => null,
        ),
      checkStationAuth: (pw) => api.checkStationAuth(pw),
    });
    if (!openRef.current) return;
    if (result.verdict === 'accepted') {
      await store(draft);
      return;
    }
    setOutcome(result);
    setBusy(false);
  };

  const saveAnyway = async () => {
    if (!draft || busy) return;
    setBusy(true);
    await store(draft);
  };

  const removeLogin = () => {
    Alert.alert(
      'Remove station login?',
      `${name} will be opened without a login. If it asks for one, it won't play until you add it again.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setError(undefined);
            setOutcome(null);
            try {
              await saveLogin(base, null);
              setSaved(null);
              setUsername('');
              setPassword('');
            } catch {
              setError("Couldn't update secure storage, so the saved login was left in place.");
            }
          },
        },
      ],
    );
  };

  const forgetPassword = () => {
    Alert.alert(
      'Forget station password?',
      `The app will ask for ${name}'s station password again.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Forget',
          style: 'destructive',
          onPress: async () => {
            setError(undefined);
            try {
              await forgetStationPasswordFor(base);
              setHasPassword(false);
            } catch {
              setError("Couldn't update secure storage, so the saved password was left in place.");
            }
          },
        },
      ],
    );
  };

  const message = outcome ? outcomeCopy(outcome) : null;

  return (
    <SafeAreaView className="flex-1 bg-bg">
      <View className="flex-row items-center justify-between px-5 pt-4 pb-1">
        <Text className="font-display text-ink" style={{ fontSize: 24 }}>
          Station login
        </Text>
        <Pressable onPress={close} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
          <X size={20} color={colors.ink} />
        </Pressable>
      </View>

      <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          className="flex-1 px-5"
          contentContainerStyle={{ paddingBottom: 32 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={{ borderWidth: 1, borderColor: colors.softBorder, padding: 14, gap: 4, marginTop: 14 }}>
            <Text className="font-body-semibold text-ink" style={{ fontSize: 16 }} numberOfLines={1}>
              {name}
            </Text>
            <Text className="font-mono text-muted" style={{ fontSize: 11 }} numberOfLines={1}>
              {stripProto(base)}
            </Text>
          </View>

          <Text className="font-body text-muted" style={{ fontSize: 13, lineHeight: 20, marginTop: 14 }}>
            The username and password a reverse proxy in front of this station asks for. The
            station checks a changed login before it is saved.
          </Text>

          {loaded === 'loading' ? (
            <ActivityIndicator color={colors.accent} style={{ marginTop: 24 }} accessibilityLabel="Loading the saved login" />
          ) : null}

          {loaded === 'failed' ? (
            <Text accessibilityRole="alert" className="font-body" style={{ color: DANGER, fontSize: 12.5, lineHeight: 19, marginTop: 16 }}>
              Couldn&apos;t read this station&apos;s login from secure storage. Unlock the device and open
              this screen again; nothing was changed.
            </Text>
          ) : null}

          {loaded === 'ready' ? (
            <>
              <Divider>{saved ? `Saved login · ${saved.username || 'no username'}` : 'No login saved'}</Divider>
              <LoginFields
                username={username}
                password={password}
                onChangeUsername={edit(setUsername)}
                onChangePassword={edit(setPassword)}
                onSubmit={save}
                editable={!busy}
              />

              {message ? (
                <Text accessibilityRole="alert" className="font-body" style={{ color: DANGER, fontSize: 12.5, lineHeight: 19, marginTop: 10 }}>
                  {message}
                </Text>
              ) : null}
              {error ? (
                <Text accessibilityRole="alert" className="font-body" style={{ color: DANGER, fontSize: 12.5, lineHeight: 19, marginTop: 10 }}>
                  {error}
                </Text>
              ) : null}

              <Pressable
                onPress={save}
                disabled={!canSave}
                accessibilityRole="button"
                accessibilityLabel="Check and save login"
                accessibilityState={{ disabled: !canSave, busy }}
                className="flex-row items-center justify-center"
                style={{ gap: 8, marginTop: 14, backgroundColor: colors.accent, paddingVertical: 15, opacity: canSave ? 1 : 0.45 }}
              >
                {busy ? <ActivityIndicator size="small" color="#fff" /> : <KeyRound size={14} color="#fff" />}
                <Text className="font-body-semibold" style={{ color: '#fff', fontSize: 14, letterSpacing: 0.3 }}>
                  {busy ? 'Checking…' : 'Check and save'}
                </Text>
              </Pressable>

              {outcome && saveAnywayOffered(outcome) ? (
                <Pressable
                  onPress={saveAnyway}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={
                    outcome.verdict === 'rejected'
                      ? "Save anyway, although the station's password check refused it"
                      : 'Save anyway without checking'
                  }
                  className="items-center justify-center"
                  style={{ marginTop: 10, borderWidth: 1, borderColor: colors.accent, paddingVertical: 13, opacity: busy ? 0.45 : 1 }}
                >
                  <Text className="font-body text-accent" style={{ fontSize: 13 }}>
                    Save anyway
                  </Text>
                </Pressable>
              ) : null}

              {saved ? (
                <Pressable
                  onPress={removeLogin}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel="Remove the saved login"
                  className="items-center"
                  style={{ marginTop: 12, paddingVertical: 8 }}
                >
                  <Text className="font-mono" style={{ color: DANGER, fontSize: 10.5, letterSpacing: 1.6, textTransform: 'uppercase' }}>
                    Remove login
                  </Text>
                </Pressable>
              ) : null}

              {hasPassword ? (
                <>
                  <Divider>Station password</Divider>
                  <Text className="font-body text-muted" style={{ fontSize: 13, lineHeight: 20 }}>
                    This station&apos;s private-station password is saved on this device. Forget it
                    to be asked for it again.
                  </Text>
                  <Pressable
                    onPress={forgetPassword}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel="Forget the saved station password"
                    className="items-center justify-center"
                    style={{ marginTop: 12, borderWidth: 1, borderColor: colors.muted, paddingVertical: 13 }}
                  >
                    <Text className="font-body text-ink" style={{ fontSize: 13 }}>
                      Forget station password
                    </Text>
                  </Pressable>
                </>
              ) : null}
            </>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
