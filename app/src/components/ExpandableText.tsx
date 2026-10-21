// Clamped text with a More/Less control that appears only when the text
// actually overflows — measured, not assumed. The measuring copy is unclamped
// and invisible: onTextLayout under numberOfLines does not report the full
// line count the same way on iOS and Android. The clamp is visual only;
// screen readers get the whole string either way.

import { useState } from 'react';
import { Pressable, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { useTheme } from '@/theme/ThemeContext';

export interface ExpandableTextProps {
  text: string;
  /** Lines shown while collapsed. */
  lines: number;
  className?: string;
  style?: StyleProp<TextStyle>;
}

export default function ExpandableText({ text, lines, className, style }: ExpandableTextProps) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  const measure = (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', left: 0, right: 0, opacity: 0 }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text
        className={className}
        style={style}
        onTextLayout={(e) => setOverflows(e.nativeEvent.lines.length > lines)}
      >
        {text}
      </Text>
    </View>
  );

  if (!overflows) {
    return (
      <View>
        {measure}
        <Text className={className} style={style} numberOfLines={lines}>
          {text}
        </Text>
      </View>
    );
  }

  return (
    <View>
      {measure}
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityHint={expanded ? 'Shows less' : 'Shows the full text'}
      >
        <Text className={className} style={style} numberOfLines={expanded ? undefined : lines}>
          {text}
        </Text>
        <Text className="font-mono" style={{ fontSize: 9, letterSpacing: 2, marginTop: 3, color: colors.accent }}>
          {expanded ? 'LESS' : 'MORE'}
        </Text>
      </Pressable>
    </View>
  );
}
