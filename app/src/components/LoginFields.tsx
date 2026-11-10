// The "Station login" fields, shared by adding a station (onboarding) and
// editing a saved one's login (station-login, #1873). The login is the HTTP
// Basic Auth pair a reverse proxy may ask for, never the station password.

import { Alert, Text, TextInput, View } from 'react-native';
import { useTheme } from '@/theme/ThemeContext';

/** Ask before a login is sent to a station over plain http://. */
export function confirmCleartextLogin(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      'Send station login over HTTP?',
      'Plain HTTP exposes the username and password to the network. Only continue for a station and network you trust.',
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Continue over HTTP', style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

export interface LoginFieldsProps {
  username: string;
  password: string;
  onChangeUsername: (value: string) => void;
  onChangePassword: (value: string) => void;
  /** The password field's return key. */
  onSubmit: () => void;
  editable?: boolean;
}

export default function LoginFields({
  username,
  password,
  onChangeUsername,
  onChangePassword,
  onSubmit,
  editable,
}: LoginFieldsProps) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 8, paddingBottom: 4 }}>
      <View>
        <Text
          className="font-mono text-muted"
          style={{ fontSize: 9, letterSpacing: 1.4, textTransform: 'uppercase', marginBottom: 5 }}
        >
          Username
        </Text>
        <TextInput
          value={username}
          onChangeText={onChangeUsername}
          placeholder="dj"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="username"
          textContentType="username"
          returnKeyType="next"
          editable={editable}
          accessibilityLabel="Station username"
          className="font-mono"
          style={{
            color: colors.ink,
            backgroundColor: colors.field,
            borderWidth: 1,
            borderColor: colors.muted,
            fontSize: 14,
            paddingVertical: 12,
            paddingHorizontal: 13,
          }}
        />
      </View>
      <View>
        <Text
          className="font-mono text-muted"
          style={{ fontSize: 9, letterSpacing: 1.4, textTransform: 'uppercase', marginBottom: 5 }}
        >
          Password
        </Text>
        <TextInput
          value={password}
          onChangeText={onChangePassword}
          placeholder="Password"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="password"
          textContentType="password"
          secureTextEntry
          returnKeyType="go"
          onSubmitEditing={onSubmit}
          editable={editable}
          accessibilityLabel="Station password"
          className="font-mono"
          style={{
            color: colors.ink,
            backgroundColor: colors.field,
            borderWidth: 1,
            borderColor: colors.muted,
            fontSize: 14,
            paddingVertical: 12,
            paddingHorizontal: 13,
          }}
        />
      </View>
      <Text className="font-mono text-muted" style={{ fontSize: 9.5, lineHeight: 14 }}>
        Saved in this device&apos;s secure credential storage.
      </Text>
    </View>
  );
}
