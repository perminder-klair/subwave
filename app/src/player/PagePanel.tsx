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
}

export default function PagePanel({ title, sub, children }: PagePanelProps) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 18, paddingBottom: insets.bottom + 18 }}
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
