// M-A12 W1-C — the Find bar (search field, "n of m", previous / next, close) and the
// highlight boxes drawn over a PDF page, plus the page navigator ("Page n of N" with up
// and down arrows) shared by the editor and signing.
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { useTheme } from '../../theme';
import { pageLabel, type NormRect } from './findModel';

const HIGHLIGHT = 'rgba(255,201,61,0.45)';
const HIGHLIGHT_CURRENT = 'rgba(255,149,0,0.6)';

function IconButton({
  label,
  d,
  onPress,
  disabled,
  testID,
}: {
  readonly label: string;
  readonly d: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly testID?: string;
}) {
  const t = useTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      hitSlop={6}
      style={[styles.icon, { minWidth: t.size.minTouch, minHeight: t.size.minTouch, opacity: disabled ? 0.4 : 1 }]}
    >
      <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={t.color.text} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <Path d={d} />
      </Svg>
    </Pressable>
  );
}

export const ICON_UP = 'M6 15l6-6 6 6';
export const ICON_DOWN = 'M6 9l6 6 6-6';
const ICON_CLOSE = 'M6 6l12 12M18 6L6 18';

export function FindBar({
  query,
  onQuery,
  status,
  canStep,
  onPrev,
  onNext,
  onClose,
}: {
  readonly query: string;
  readonly onQuery: (q: string) => void;
  /** "3 of 12", "No matches", "No searchable text in this document", … */
  readonly status: string;
  readonly canStep: boolean;
  readonly onPrev: () => void;
  readonly onNext: () => void;
  readonly onClose: () => void;
}) {
  const t = useTheme();
  return (
    <View
      testID="find-bar"
      style={[styles.bar, { backgroundColor: t.color.surface, borderBottomColor: t.color.separator }]}
    >
      <View style={styles.row}>
        <TextInput
          testID="find-input"
          value={query}
          onChangeText={onQuery}
          placeholder="Find in document"
          placeholderTextColor={t.color.textTertiary}
          accessibilityLabel="Find in document"
          autoFocus
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          onSubmitEditing={onNext}
          style={[
            styles.input,
            { color: t.color.text, borderColor: t.color.separator, backgroundColor: t.color.screen, fontFamily: t.font.family },
          ]}
        />
        <IconButton testID="find-prev" label="Previous match" d={ICON_UP} onPress={onPrev} disabled={!canStep} />
        <IconButton testID="find-next" label="Next match" d={ICON_DOWN} onPress={onNext} disabled={!canStep} />
        <IconButton testID="find-close" label="Close find" d={ICON_CLOSE} onPress={onClose} />
      </View>
      <Text
        testID="find-status"
        accessibilityLiveRegion="polite"
        style={{ color: t.color.textSecondary, fontSize: 13, fontFamily: t.font.family }}
      >
        {status}
      </Text>
    </View>
  );
}

/** Highlight boxes over one rendered page (`width` × `height` in dp). */
export function HighlightOverlay({
  rects,
  width,
  height,
}: {
  readonly rects: readonly { readonly rect: NormRect; readonly current: boolean }[];
  readonly width: number;
  readonly height: number;
}) {
  if (rects.length === 0) return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} testID="find-highlights">
      {rects.map(({ rect, current }, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: rect.x * width - 1,
            top: rect.y * height - 1,
            width: rect.w * width + 2,
            height: rect.h * height + 2,
            backgroundColor: current ? HIGHLIGHT_CURRENT : HIGHLIGHT,
            borderRadius: 2,
          }}
        />
      ))}
    </View>
  );
}

/** "Page n of N" with up / down arrows (W1-C.1). */
export function PageNavigator({
  current,
  total,
  onPrev,
  onNext,
}: {
  /** 1-based. */
  readonly current: number;
  readonly total: number;
  readonly onPrev: () => void;
  readonly onNext: () => void;
}) {
  const t = useTheme();
  return (
    <View style={styles.nav} testID="page-nav">
      <IconButton testID="page-prev" label="Previous page" d={ICON_UP} onPress={onPrev} disabled={current <= 1} />
      <Text
        testID="page-label"
        accessibilityLiveRegion="polite"
        style={{ color: t.color.text, fontSize: 14, fontFamily: t.font.family, minWidth: 92, textAlign: 'center' }}
      >
        {pageLabel(current, total)}
      </Text>
      <IconButton testID="page-next" label="Next page" d={ICON_DOWN} onPress={onNext} disabled={current >= total} />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: 12, paddingVertical: 8, gap: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  input: { flex: 1, minHeight: 40, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, fontSize: 16 },
  icon: { alignItems: 'center', justifyContent: 'center' },
  nav: { flexDirection: 'row', alignItems: 'center' },
});
