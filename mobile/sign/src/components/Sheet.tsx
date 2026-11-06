// Bottom sheet primitive (handoff §3 "Sheet"). iOS uses the native page sheet
// (UISheetPresentationController via RN Modal `pageSheet`: swipe-to-dismiss, system
// grabber behaviour); Android renders the Material 3 modal bottom sheet look (28 top
// radius, 32x4 grabber, scrim). For a sheet that needs detents, register it as a
// native-stack route with `presentation: 'formSheet'` + `sheetAllowedDetents` instead
// (see navigation/RootNavigator.tsx). Modal content is its own root, so it gets its own
// GestureHandlerRootView for gesture-handler gestures inside the sheet.
import { useState, type ReactNode } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../theme';
import { androidSheetPlacement, useFocusFallback, useKeyboardHeight } from './sheetKeyboard';

export interface SheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly title?: string;
  readonly children: ReactNode;
  /** false while the content handles drags itself (e.g. a signature pad). */
  readonly scrollEnabled?: boolean;
}

export function Sheet({ visible, onClose, title, children, scrollEnabled = true }: SheetProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  // M-A13 #5 — keyboard-aware (see sheetKeyboard.ts).
  const keyboard = useKeyboardHeight(visible && Platform.OS === 'android');
  const fallback = useFocusFallback(keyboard);
  const [heights, setHeights] = useState({ full: 0, current: 0 });
  const grabber = (
    <View
      style={[
        styles.grabber,
        {
          width: t.size.grabber.width,
          height: t.size.grabber.height,
          backgroundColor: t.color.grabber,
        },
      ]}
    />
  );
  const header = title ? (
    <Text
      accessibilityRole="header"
      style={[styles.title, { color: t.color.text, fontFamily: t.font.family }]}
    >
      {title}
    </Text>
  ) : null;

  if (Platform.OS === 'ios') {
    return (
      <Modal
        visible={visible}
        onRequestClose={onClose}
        presentationStyle="pageSheet"
        animationType="slide"
      >
        <GestureHandlerRootView
          style={[styles.fill, { backgroundColor: t.color.sheet, paddingBottom: insets.bottom }]}
        >
          {grabber}
          {header}
          <ScrollView
            contentContainerStyle={styles.content}
            scrollEnabled={scrollEnabled}
            automaticallyAdjustKeyboardInsets
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
        </GestureHandlerRootView>
      </Modal>
    );
  }
  const placement = androidSheetPlacement({
    keyboard,
    fullHeight: heights.full,
    rootHeight: heights.current,
    focusedWithoutEvent: fallback.focusedWithoutEvent,
  });
  return (
    <Modal
      visible={visible}
      onRequestClose={onClose}
      transparent
      animationType="fade"
      statusBarTranslucent
    >
      <GestureHandlerRootView
        style={styles.fill}
        onLayout={(e) => {
          const h = e.nativeEvent.layout.height;
          setHeights((prev) => ({ full: Math.max(prev.full, h), current: h }));
        }}
      >
        <Pressable
          style={styles.scrim}
          onPress={onClose}
          accessibilityLabel="Close"
          accessibilityRole="button"
        />
        <View
          testID="sheet-android"
          onFocus={fallback.onFocus}
          onBlur={fallback.onBlur}
          style={[
            styles.androidSheet,
            placement.kind === 'top'
              ? { top: insets.top + 8, bottom: undefined }
              : { bottom: placement.lift },
            {
              backgroundColor: t.color.sheet,
              borderTopLeftRadius: t.size.sheetTopRadius,
              borderTopRightRadius: t.size.sheetTopRadius,
              // Over the keyboard the navigation bar inset is already covered.
              paddingBottom:
                (placement.kind === 'bottom' && placement.lift > 0 ? 0 : insets.bottom) + 16,
            },
          ]}
        >
          {grabber}
          {header}
          <ScrollView
            contentContainerStyle={styles.content}
            scrollEnabled={scrollEnabled}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grabber: { alignSelf: 'center', borderRadius: 3, marginTop: 8, marginBottom: 8 },
  title: { fontSize: 20, fontWeight: '600', paddingHorizontal: 20, paddingBottom: 8 },
  content: { paddingHorizontal: 20, paddingBottom: 20, gap: 12 },
  scrim: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.32)',
  },
  androidSheet: { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '90%' },
});
