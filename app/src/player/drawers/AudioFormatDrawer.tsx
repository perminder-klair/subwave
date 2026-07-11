import { Check } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';
import {
  FORMAT_OPTIONS,
  type AudioFormat,
  type FormatAvailability,
} from '@/lib/audioFormat';
import { useTheme } from '@/theme/ThemeContext';

const REASON_TEXT = {
  station: 'Not enabled by station',
  device: 'Not supported on this device',
  failed: 'Playback failed this session',
} as const;

export interface AudioFormatDrawerProps {
  format: AudioFormat;
  availability: FormatAvailability;
  formatFailure: AudioFormat | null;
  onSelect: (format: AudioFormat) => void;
}

export default function AudioFormatDrawer({
  format,
  availability,
  formatFailure,
  onSelect,
}: AudioFormatDrawerProps) {
  const { colors } = useTheme();

  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Audio format">
      {formatFailure ? (
        <Text className="font-body text-muted" style={{ fontSize: 13, marginBottom: 12 }}>
          Playback fell back to MP3.
        </Text>
      ) : null}

      {FORMAT_OPTIONS.map((option) => {
        const selected = format === option.id;
        const state = availability[option.id];
        const disabled = !state.available;
        const reason = state.reason ? REASON_TEXT[state.reason] : null;

        return (
          <Pressable
            key={option.id}
            onPress={() => onSelect(option.id)}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityLabel={`${option.label}: ${reason ?? option.description}`}
            accessibilityState={{ checked: selected, disabled }}
            className="flex-row items-center justify-between"
            style={{
              borderWidth: 1,
              borderColor: selected ? colors.accent : colors.softBorder,
              paddingHorizontal: 14,
              paddingVertical: 12,
              marginBottom: 10,
              opacity: disabled ? 0.52 : 1,
            }}
          >
            <View className="flex-1" style={{ paddingRight: 12 }}>
              <Text
                className="font-body-semibold text-ink"
                style={{ fontSize: 15, color: selected ? colors.accent : colors.ink }}
              >
                {option.label}
              </Text>
              <Text className="font-body text-muted" style={{ fontSize: 12, marginTop: 2 }}>
                {reason ?? option.description}
              </Text>
            </View>
            {selected ? <Check size={18} color={colors.accent} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}
