// Sleep-timer sheet: arm a duration and playback tunes out when it lapses.
// When armed, a live countdown heads the sheet with a cancel row; the duration
// rows below re-arm (replace) the running timer. Follows the ThemesDrawer row
// styling so the two bottom sheets read as one family.

import { Check, MoonStar } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { Pressable, Text, View } from 'react-native';
import { fmtTime } from '@/lib/format';
import { useTheme } from '@/theme/ThemeContext';

const OPTIONS_MIN = [15, 30, 45, 60, 90];

export interface SleepDrawerProps {
  active: boolean;
  armedMinutes: number | null;
  remainingSec: number | null;
  onStart: (minutes: number) => void;
  onCancel: () => void;
}

export default function SleepDrawer({ active, armedMinutes, remainingSec, onStart, onCancel }: SleepDrawerProps) {
  const { colors } = useTheme();

  return (
    <View>
      {active ? (
        <View
          className="flex-row items-center justify-between"
          style={{
            borderWidth: 1,
            borderColor: colors.accent,
            paddingHorizontal: 14,
            paddingVertical: 12,
            marginBottom: 14,
          }}
        >
          <View className="flex-row items-center" style={{ gap: 10 }}>
            <MoonStar size={18} color={colors.accent} />
            <View>
              <Text className="font-mono text-accent" style={{ fontSize: 9, letterSpacing: 3 }}>
                TUNING OUT IN
              </Text>
              <Text className="font-body-semibold text-ink" style={{ fontSize: 22, marginTop: 2 }}>
                {fmtTime(remainingSec)}
              </Text>
            </View>
          </View>
          <Pressable
            onPress={() => {
              Haptics.selectionAsync().catch(() => {});
              onCancel();
            }}
            accessibilityRole="button"
            accessibilityLabel="Cancel sleep timer"
            style={{
              borderWidth: 1,
              borderColor: colors.softBorder,
              paddingHorizontal: 12,
              paddingVertical: 7,
            }}
          >
            <Text className="font-mono text-muted" style={{ fontSize: 10, letterSpacing: 2 }}>
              CANCEL
            </Text>
          </Pressable>
        </View>
      ) : (
        <Text className="font-body text-muted" style={{ fontSize: 13, marginBottom: 12 }}>
          The radio tunes itself out when the timer lapses — drift off without
          playing all night.
        </Text>
      )}

      {OPTIONS_MIN.map((min) => {
        const selected = active && armedMinutes === min;
        return (
          <Pressable
            key={min}
            onPress={() => {
              Haptics.selectionAsync().catch(() => {});
              onStart(min);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Sleep in ${min} minutes`}
            accessibilityState={{ selected }}
            className="flex-row items-center justify-between"
            style={{ paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.softBorder }}
          >
            <Text className="font-body-medium text-ink" style={{ fontSize: 15 }}>
              {min} minutes
            </Text>
            {selected ? <Check size={18} color={colors.accent} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}
