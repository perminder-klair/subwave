// One bottom sheet, content switched by the active drawer — mirrors the single
// <Sheet> in web PlayerApp. Driven by an `open` prop (present/dismiss) so the
// caller stays declarative. Uses @gorhom/bottom-sheet's modal.

import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Text, View } from 'react-native';
import { useTheme } from '@/theme/ThemeContext';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children?: React.ReactNode;
}

export function Sheet({ open, onClose, title, children }: SheetProps) {
  const ref = useRef<BottomSheetModal>(null);
  const { colors } = useTheme();
  const snapPoints = useMemo(() => ['60%', '92%'], []);

  useEffect(() => {
    if (open) ref.current?.present();
    else ref.current?.dismiss();
  }, [open]);

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

  return (
    <BottomSheetModal
      ref={ref}
      snapPoints={snapPoints}
      onDismiss={onClose}
      enablePanDownToClose
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
    </BottomSheetModal>
  );
}
