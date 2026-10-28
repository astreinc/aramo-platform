// Bottom sheet primitive (handoff §3 "Sheet"). iOS uses the native page sheet
// (UISheetPresentationController via RN Modal `pageSheet`: swipe-to-dismiss, system
// grabber behaviour); Android renders the Material 3 modal bottom sheet look (28 top
// radius, 32x4 grabber, scrim). For a sheet that needs detents, register it as a
// native-stack route with `presentation: 'formSheet'` + `sheetAllowedDetents` instead
// (see navigation/RootNavigator.tsx). Modal content is its own root, so it gets its own
// GestureHandlerRootView for gesture-handler gestures inside the sheet.
import type { ReactNode } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../theme';

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
          <ScrollView contentContainerStyle={styles.content} scrollEnabled={scrollEnabled}>
            {children}
          </ScrollView>
        </GestureHandlerRootView>
      </Modal>
    );
  }
  return (
    <Modal
      visible={visible}
      onRequestClose={onClose}
      transparent
      animationType="fade"
      statusBarTranslucent
    >
      <GestureHandlerRootView style={styles.fill}>
        <Pressable
          style={styles.scrim}
          onPress={onClose}
          accessibilityLabel="Close"
          accessibilityRole="button"
        />
        <View
          style={[
            styles.androidSheet,
            {
              backgroundColor: t.color.sheet,
              borderTopLeftRadius: t.size.sheetTopRadius,
              borderTopRightRadius: t.size.sheetTopRadius,
              paddingBottom: insets.bottom + 16,
            },
          ]}
        >
          {grabber}
          {header}
          <ScrollView contentContainerStyle={styles.content} scrollEnabled={scrollEnabled}>
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
