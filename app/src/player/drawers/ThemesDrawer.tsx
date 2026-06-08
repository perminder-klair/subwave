// Per-listener theme picker. Reads the station's theme registry (from /themes
// via ThemeContext) and lets the listener override the palette locally — mirrors
// the web ThemeSwitcher. "Follow station" clears the override.

import { Check } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';
import { useTheme } from '@/theme/ThemeContext';

export default function ThemesDrawer() {
  const { themes, activeId, colors, setOverride } = useTheme();

  return (
    <View>
      <Pressable
        onPress={() => setOverride(null)}
        className="flex-row items-center justify-between"
        style={{ paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.softBorder }}
      >
        <View>
          <Text className="font-body-medium text-ink" style={{ fontSize: 15 }}>Follow station</Text>
          <Text className="font-body text-muted" style={{ fontSize: 12 }}>
            Use whatever palette the station broadcasts
          </Text>
        </View>
      </Pressable>

      {themes.map((theme) => {
        const swatch = theme.tokens['--accent'] || colors.accent;
        const bg = theme.tokens['--bg'] || colors.bg;
        return (
          <Pressable
            key={theme.id}
            onPress={() => setOverride(theme.id)}
            className="flex-row items-center"
            style={{ gap: 12, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.softBorder }}
          >
            <View
              style={{
                width: 32,
                height: 32,
                borderRadius: 16,
                backgroundColor: bg,
                borderWidth: 1,
                borderColor: colors.softBorder,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: swatch }} />
            </View>
            <View className="flex-1">
              <Text className="font-body-medium text-ink" style={{ fontSize: 15 }}>{theme.name}</Text>
              {theme.description ? (
                <Text className="font-body text-muted" style={{ fontSize: 12 }} numberOfLines={1}>
                  {theme.description}
                </Text>
              ) : null}
            </View>
            {theme.id === activeId ? <Check size={18} color={colors.accent} /> : null}
          </Pressable>
        );
      })}

      {themes.length === 0 ? (
        <Text className="font-body text-muted" style={{ fontSize: 13, paddingVertical: 16 }}>
          This station hasn't published any themes.
        </Text>
      ) : null}
    </View>
  );
}
