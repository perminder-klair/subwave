// Scrollable page shell for the swipe-pager sections (Shows / Timeline / Booth /
// Request). Provides the panel header — a serif title with a mono uppercase
// sub-label under an ink rule — that the web mock draws on each section, then
// scrolls its content. The Live section is bespoke and doesn't use this.

import type { ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/ThemeContext';

export interface PagePanelProps {
  title: string;
  sub?: string;
  children: ReactNode;
  /** Footprint of the overlaid masthead/dial header, so content starts clear of
      it but scrolls under the frosted glass. Falls back to the safe area top. */
  topInset?: number;
  /** Footprint of the overlaid transport bar, so content can scroll clear of
      it (and read as flowing under the frosted glass). Falls back to the safe
      area when the bar hasn't measured yet. */
  bottomInset?: number;
}

export default function PagePanel({ title, sub, children, topInset, bottomInset }: PagePanelProps) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingTop: (topInset || insets.top) + 18,
        paddingBottom: (bottomInset || insets.bottom) + 18,
      }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 12,
          borderBottomWidth: 1,
          borderBottomColor: colors.ink,
          paddingBottom: 12,
          marginBottom: 16,
        }}
      >
        <Text className="font-display text-ink" style={{ fontSize: 22 }} numberOfLines={1}>
          {title}
        </Text>
        {sub ? (
          <Text
            className="font-mono text-muted"
            style={{ fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase' }}
            numberOfLines={1}
          >
            {sub}
          </Text>
        ) : null}
      </View>
      {children}
    </ScrollView>
  );
}
