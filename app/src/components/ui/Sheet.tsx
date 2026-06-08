// One bottom sheet, content switched by the active drawer — mirrors the single
// <Sheet> in web PlayerApp.
//
// Driven declaratively by a controlled `index` (0 = open, -1 = closed) rather
// than imperative present()/dismiss() on a modal ref. The modal+ref+effect
// approach proved flaky here (the sheet's state and the present() call could
// race, so it took multiple taps to open); a controlled non-modal BottomSheet
// animates straight to the target index and is reliable on the first tap.

import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { useCallback, useMemo, useRef } from 'react';
import { Text, View } from 'react-native';
import { useTheme } from '@/theme/ThemeContext';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children?: React.ReactNode;
}

export function Sheet({ open, onClose, title, children }: SheetProps) {
  const ref = useRef<BottomSheet>(null);
  const { colors } = useTheme();
  const snapPoints = useMemo(() => ['60%', '92%'], []);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="close"
        opacity={0.5}
      />
    ),
    [],
  );

  // onClose() is the single source of truth for "user dismissed it" — fired
  // when the sheet animates to index -1 (pan-down or backdrop press).
  const handleChange = useCallback(
    (index: number) => {
      if (index === -1 && open) onClose();
    },
    [open, onClose],
  );

  return (
    <BottomSheet
      ref={ref}
      index={open ? 0 : -1}
      snapPoints={snapPoints}
      // Explicit snapPoints → dynamic content sizing must be OFF, or the first
      // layout mis-measures the scroll view height.
      enableDynamicSizing={false}
      enablePanDownToClose
      onChange={handleChange}
      backdropComponent={renderBackdrop}
      handleIndicatorStyle={{ backgroundColor: colors.muted }}
      backgroundStyle={{ backgroundColor: colors.bg }}
    >
      <BottomSheetScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 48 }}
      >
        {title ? (
          <Text
            className="font-display text-ink"
            style={{ fontSize: 22, marginTop: 4, marginBottom: 16 }}
          >
            {title}
          </Text>
        ) : null}
        <View>{children}</View>
      </BottomSheetScrollView>
    </BottomSheet>
  );
}
