// M-A14 §1 item 5 (a15) — "Finishing…": shown while the real completion call runs (R-1:
// no timer). A blurred gradient backdrop, a white rounded card with the 4-dot spinner. On
// failure the card shows the message with Try again (and Cancel).
import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useReducedMotion } from '../../../features/signing/useReducedMotion';
import { useTheme } from '../../../theme';
import { FinishingBackdrop, INK, SECONDARY } from './art';
import { FilledButton, TextAction } from './ui';

export interface FinishingScreenProps {
  readonly state: 'working' | 'failed';
  readonly message?: string;
  readonly onRetry: () => void;
  readonly onCancel: () => void;
}

export const FINISH_FAILED_FALLBACK = 'We couldn’t finish signing. Check your connection and try again.';

// Prototype: left/top/size/colour of each dot inside a 52×50 box; 1.1 s pulse, 0.2 s apart.
const DOTS = [
  { left: 6, top: 10, size: 11, color: 'rgba(46,140,96,0.75)' },
  { left: 30, top: 4, size: 11, color: 'rgba(46,140,96,0.3)' },
  { left: 36, top: 28, size: 12, color: '#3C6DD8' },
  { left: 10, top: 34, size: 11, color: 'rgba(60,109,216,0.4)' },
] as const;
const PERIOD = 1100;
const STAGGER = 200;

function Dot({ index, still }: { readonly index: number; readonly still: boolean }) {
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (still) {
      v.setValue(0.5);
      return undefined;
    }
    const half = PERIOD / 2;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: half, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: half, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    const start = setTimeout(() => loop.start(), index * STAGGER);
    return () => {
      clearTimeout(start);
      loop.stop();
    };
  }, [v, index, still]);
  const d = DOTS[index]!;
  return (
    <Animated.View
      style={{
        position: 'absolute',
        left: d.left,
        top: d.top,
        width: d.size,
        height: d.size,
        borderRadius: d.size / 2,
        backgroundColor: d.color,
        opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }),
        transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1.15] }) }],
      }}
    />
  );
}

export function FinishingScreen({ state, message, onRetry, onCancel }: FinishingScreenProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const still = useReducedMotion();
  const failed = state === 'failed';
  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <FinishingBackdrop />
      <View style={styles.card}>
        {failed ? (
          <View style={styles.failed} accessibilityLiveRegion="assertive">
            <Text
              testID="finishing-error"
              accessibilityRole="alert"
              style={[styles.message, { fontFamily: t.font.family }]}
            >
              {message || FINISH_FAILED_FALLBACK}
            </Text>
            <FilledButton testID="finishing-retry" title="Try again" onPress={onRetry} />
            <TextAction testID="finishing-cancel" title="Cancel" onPress={onCancel} />
          </View>
        ) : (
          <View
            style={styles.working}
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel="Finishing"
            accessibilityState={{ busy: true }}
          >
            <View style={styles.dots}>
              {DOTS.map((_, i) => (
                <Dot key={i} index={i} still={still} />
              ))}
            </View>
            <Text style={[styles.label, { fontFamily: t.font.family }]}>Finishing…</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', overflow: 'hidden', paddingHorizontal: 20 },
  card: {
    alignSelf: 'stretch',
    minHeight: 242,
    borderRadius: 34,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 28,
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 25,
    shadowOffset: { width: 0, height: 20 },
    elevation: 12,
  },
  working: { alignItems: 'center', gap: 26 },
  dots: { width: 52, height: 50 },
  label: { color: INK, fontSize: 17, fontWeight: '500' },
  failed: { alignSelf: 'stretch', alignItems: 'center', gap: 16 },
  message: { color: SECONDARY, fontSize: 16, lineHeight: 23, textAlign: 'center' },
});
