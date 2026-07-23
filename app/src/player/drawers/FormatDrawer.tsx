// Stream-format sheet: pick which Icecast mount this radio pulls. Everyone
// hears the same broadcast — this only changes the encoding between the
// station and this device. Options are already filtered upstream
// (useStreamFormat) to what the platform can decode AND what the station has
// enabled, so every row here is genuinely tunable. Follows the SleepDrawer/
// ThemesDrawer row styling so the bottom sheets read as one family.

import { Check } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { Pressable, Text, View } from 'react-native';
import type { StreamFormat, StreamFormatOption } from '@/lib/streamFormat';
import { useTheme } from '@/theme/ThemeContext';

export interface FormatDrawerProps {
  options: StreamFormatOption[];
  /** The listener's raw pick (what reads as selected). */
  selected: StreamFormat;
  onSelect: (format: StreamFormat) => void;
}

export default function FormatDrawer({ options, selected, onSelect }: FormatDrawerProps) {
  const { colors } = useTheme();

  return (
    <View>
      <Text className="font-body text-muted" style={{ fontSize: 13, marginBottom: 12 }}>
        Same broadcast, different encoding — pick what this radio pulls. MP3 is
        the most compatible; the others trade compatibility for quality or
        data. Switching retunes in place.
      </Text>

      {options.map((opt) => {
        const isSelected = opt.format === selected;
        return (
          <Pressable
            key={opt.format}
            onPress={() => {
              Haptics.selectionAsync().catch(() => {});
              onSelect(opt.format);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Stream as ${opt.label}`}
            accessibilityState={{ selected: isSelected }}
            className="flex-row items-center justify-between"
            style={{ paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.softBorder }}
          >
            <View className="flex-row items-baseline" style={{ gap: 10 }}>
              <Text className="font-body-medium text-ink" style={{ fontSize: 15 }}>
                {opt.label}
              </Text>
              <Text className="font-mono text-muted" style={{ fontSize: 10, letterSpacing: 1 }}>
                {opt.detail}
              </Text>
            </View>
            {isSelected ? <Check size={18} color={colors.accent} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}
