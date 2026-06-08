// Per-listener theme picker, styled after the web mock's theme grid: a
// "Follow station" row, then a 2-column grid of theme cards — each a tri-tone
// swatch (bg / ink / accent) above a name bar painted in the theme's own colours
// with an accent dot. Selecting overrides the palette locally; "Follow station"
// clears the override. Reads the station's registry via ThemeContext.

import { Check } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';
import { useTheme } from '@/theme/ThemeContext';

export default function ThemesDrawer() {
  const { themes, activeId, colors, setOverride } = useTheme();

  return (
    <View>
      <Pressable
        onPress={() => setOverride(null)}
        accessibilityRole="button"
        accessibilityLabel="Follow station theme"
        className="flex-row items-center justify-between"
        style={{ paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.softBorder, marginBottom: 14 }}
      >
        <View className="flex-1">
          <Text className="font-body-medium text-ink" style={{ fontSize: 15 }}>Follow station</Text>
          <Text className="font-body text-muted" style={{ fontSize: 12 }}>
            Use whatever palette the station broadcasts
          </Text>
        </View>
        {!activeId ? <Check size={18} color={colors.accent} /> : null}
      </Pressable>

      <View className="flex-row flex-wrap" style={{ gap: 10 }}>
        {themes.map((theme) => {
          const t = theme.tokens;
          const bg = t['--bg'] || colors.bg;
          const ink = t['--ink'] || colors.ink;
          const accent = t['--accent'] || colors.accent;
          const on = theme.id === activeId;
          return (
            <Pressable
              key={theme.id}
              onPress={() => setOverride(theme.id)}
              accessibilityRole="button"
              accessibilityLabel={`Theme: ${theme.name}`}
              accessibilityState={{ selected: on }}
              style={{
                width: '47.5%',
                flexGrow: 1,
                borderWidth: 1,
                borderColor: on ? colors.accent : colors.softBorder,
                overflow: 'hidden',
              }}
            >
              <View className="flex-row" style={{ height: 46 }}>
                <View style={{ flex: 1, backgroundColor: bg }} />
                <View style={{ flex: 1, backgroundColor: ink }} />
                <View style={{ flex: 1, backgroundColor: accent }} />
              </View>
              <View
                className="flex-row items-center justify-between"
                style={{ backgroundColor: bg, paddingHorizontal: 10, paddingVertical: 8 }}
              >
                <Text className="font-mono" style={{ color: ink, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', fontWeight: '700' }} numberOfLines={1}>
                  {theme.name}
                </Text>
                <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: accent }} />
              </View>
            </Pressable>
          );
        })}
      </View>

      {themes.length === 0 ? (
        <Text className="font-body text-muted" style={{ fontSize: 13, paddingVertical: 16 }}>
          This station hasn&apos;t published any themes.
        </Text>
      ) : null}
    </View>
  );
}
