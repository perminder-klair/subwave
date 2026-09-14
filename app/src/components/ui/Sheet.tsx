// One bottom sheet, content switched by the active drawer.
//
// Built on RN's core <Modal>, not @gorhom/bottom-sheet: gorhom and the
// gesture-handler it rides on install a root touch interceptor that swallows
// every tap on the New Architecture on some Android devices (#458). A core
// <Modal> renders in its own native window and nothing when closed, so it
// can't intercept touches. No drag-to-dismiss; scrim tap or back closes it.

import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/ThemeContext';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children?: React.ReactNode;
}

export function Sheet({ open, onClose, title, children }: SheetProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={open}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        {/* Dimmed scrim — tap to dismiss. Sits behind the panel. */}
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)' }]}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        <View
          style={{
            maxHeight: '88%',
            backgroundColor: colors.bg,
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            paddingBottom: insets.bottom + 8,
          }}
        >
          {/* Grabber */}
          <View style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 4 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: colors.muted }} />
          </View>
          <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 48 }}>
            {title ? (
              <Text
                className="font-display text-ink"
                style={{ fontSize: 22, marginTop: 4, marginBottom: 16 }}
              >
                {title}
              </Text>
            ) : null}
            <View>{children}</View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
