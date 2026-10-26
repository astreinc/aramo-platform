// "Adopt your signature" / "initials" sheet (handoff §4.4) with Type | Draw. Both tabs
// rasterize to PNG on the device (C-19). Used by signing and by Account → Default
// signature ("Save signature").
import { useRef, useState, type RefObject } from 'react';
import {
  PanResponder,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { Button } from '../../components/Button';
import { Sheet } from '../../components/Sheet';
import { SIGNATURE_INK, useTheme } from '../../theme';
import {
  captureViewAsPng,
  initialsOf,
  markFromSaved,
  SCRIPT_FONT,
  type AdoptTarget,
  type Capture,
  type SavedMark,
} from './adopt';
import type { AdoptedMark } from './signingMachine';

export interface AdoptResult {
  readonly mark: AdoptedMark;
  readonly typedName: string;
  readonly saveDefault: boolean;
}

export interface AdoptSignatureSheetProps {
  readonly visible: boolean;
  readonly target: AdoptTarget;
  /** 'sign' → "Adopt and sign"/"Adopt and initial"; 'account' → "Save signature". */
  readonly mode: 'sign' | 'account';
  readonly defaultName: string;
  /** Offer "Save as my default" (signed in only). */
  readonly canSaveDefault: boolean;
  readonly saved?: SavedMark | null;
  readonly onAdopt: (r: AdoptResult) => void | Promise<void>;
  readonly onClose: () => void;
  /** Injected in tests; defaults to react-native-view-shot. */
  readonly capture?: Capture;
}

type Tab = 'type' | 'draw';

function pointsToPath(points: readonly { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  const [first, ...rest] = points;
  if (!first) return '';
  if (rest.length === 0) return `M${first.x} ${first.y} l0.1 0`;
  return `M${first.x} ${first.y}${rest.map((p) => ` L${p.x} ${p.y}`).join('')}`;
}

export function AdoptSignatureSheet({
  visible,
  target,
  mode,
  defaultName,
  canSaveDefault,
  saved,
  onAdopt,
  onClose,
  capture = captureViewAsPng,
}: AdoptSignatureSheetProps) {
  const t = useTheme();
  const [tab, setTab] = useState<Tab>('type');
  const [name, setName] = useState(defaultName);
  const [strokes, setStrokes] = useState<string[]>([]);
  const [live, setLive] = useState('');
  const [saveDefault, setSaveDefault] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typedRef = useRef<View>(null);
  const drawRef = useRef<View>(null);

  const isInitials = target === 'INITIALS';
  const typedText = isInitials ? initialsOf(name) : name.trim();
  const savedMark = markFromSaved(saved ?? null);

  // The stroke in progress lives in this closure (created once), not in a ref.
  const [pan] = useState(() => {
    let points: { x: number; y: number }[] = [];
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e: GestureResponderEvent) => {
        points = [{ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY }];
        setLive(pointsToPath(points));
      },
      onPanResponderMove: (e: GestureResponderEvent) => {
        points.push({ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY });
        setLive(pointsToPath(points));
      },
      onPanResponderRelease: () => {
        const d = pointsToPath(points);
        points = [];
        setLive('');
        if (d) setStrokes((s) => [...s, d]);
      },
    });
  });

  const ready = tab === 'type' ? typedText.length > 0 : strokes.length > 0;
  const title = isInitials ? 'Adopt your initials' : 'Adopt your signature';
  const action =
    mode === 'account'
      ? isInitials
        ? 'Save initials'
        : 'Save signature'
      : isInitials
        ? 'Adopt and initial'
        : 'Adopt and sign';

  async function finish(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const ref = (tab === 'type' ? typedRef : drawRef) as RefObject<unknown>;
      const dataUrl = await capture(ref);
      await onAdopt({
        mark: { dataUrl, method: tab === 'type' ? 'TYPED' : 'DRAWN' },
        typedName: name.trim(),
        saveDefault: mode === 'account' || (canSaveDefault && saveDefault),
      });
    } catch {
      setError('Couldn’t save that signature. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <View
        style={[styles.segment, { backgroundColor: t.color.fill, borderRadius: 9 }]}
        accessibilityRole="tablist"
      >
        {(['type', 'draw'] as const).map((k) => (
          <Pressable
            key={k}
            testID={`adopt-tab-${k}`}
            onPress={() => setTab(k)}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === k }}
            style={[
              styles.segmentItem,
              { minHeight: t.size.minTouch },
              tab === k ? { backgroundColor: t.color.surface, borderRadius: 7 } : null,
            ]}
          >
            <Text
              style={{
                color: t.color.text,
                fontWeight: tab === k ? '600' : '400',
                fontFamily: t.font.family,
              }}
            >
              {k === 'type' ? 'Type' : 'Draw'}
            </Text>
          </Pressable>
        ))}
      </View>

      {savedMark && mode === 'sign' ? (
        <Button
          variant="secondary"
          title={isInitials ? 'Use my saved initials' : 'Use my saved signature'}
          onPress={() =>
            void onAdopt({
              mark: savedMark,
              typedName: saved?.typed_name ?? '',
              saveDefault: false,
            })
          }
        />
      ) : null}

      {tab === 'type' ? (
        <>
          <TextInput
            testID="adopt-name"
            value={name}
            onChangeText={setName}
            placeholder="Full name"
            accessibilityLabel="Full name"
            autoCapitalize="words"
            autoCorrect={false}
            style={[
              styles.input,
              {
                borderColor: t.color.separator,
                color: t.color.text,
                minHeight: t.size.minTouch,
                borderRadius: t.size.cardRadius / 1.5,
                backgroundColor: t.color.surface,
              },
            ]}
          />
          <View
            style={[
              styles.preview,
              { backgroundColor: t.color.white, borderRadius: t.size.cardRadius },
            ]}
          >
            {/* Only this inner view is rasterized: transparent background, ink only. */}
            <View
              ref={typedRef}
              collapsable={false}
              style={styles.capture}
              accessibilityLabel={`Preview: ${typedText}`}
            >
              <Text
                style={[
                  isInitials ? styles.scriptInitials : styles.script,
                  { fontFamily: SCRIPT_FONT, color: SIGNATURE_INK },
                ]}
                numberOfLines={1}
                adjustsFontSizeToFit
              >
                {typedText || ' '}
              </Text>
            </View>
          </View>
        </>
      ) : (
        <View
          style={[styles.pad, { backgroundColor: t.color.white, borderRadius: t.size.cardRadius }]}
        >
          <View style={[styles.baseline, { borderColor: t.color.textTertiary }]} />
          {strokes.length === 0 && !live ? (
            <Text style={[styles.hint, { color: t.color.textTertiary }]}>
              Sign here with your finger
            </Text>
          ) : null}
          <View
            ref={drawRef}
            collapsable={false}
            style={StyleSheet.absoluteFill}
            {...pan.panHandlers}
            accessibilityLabel="Signature pad"
            accessibilityHint="Draw your signature with one finger"
          >
            <Svg width="100%" height="100%">
              {[...strokes, live].filter(Boolean).map((d, i) => (
                <Path
                  key={i}
                  d={d}
                  stroke={SIGNATURE_INK}
                  strokeWidth={4}
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </Svg>
          </View>
          <Pressable
            onPress={() => setStrokes([])}
            accessibilityRole="button"
            accessibilityLabel="Clear"
            style={[styles.clear, { minHeight: t.size.minTouch, minWidth: t.size.minTouch }]}
          >
            <Text style={{ color: t.color.accent, fontWeight: '600' }}>Clear</Text>
          </Pressable>
        </View>
      )}

      {mode === 'sign' && canSaveDefault ? (
        <View style={styles.row}>
          <Text style={{ flex: 1, color: t.color.text, fontFamily: t.font.family }}>
            {isInitials ? 'Save as my default initials' : 'Save as my default signature'}
          </Text>
          <Switch
            value={saveDefault}
            onValueChange={setSaveDefault}
            accessibilityLabel="Save as my default"
          />
        </View>
      ) : null}

      <Text
        style={{
          color: t.color.textSecondary,
          fontSize: 13,
          lineHeight: 18,
          fontFamily: t.font.family,
        }}
      >
        {mode === 'account'
          ? 'Your default is offered when you sign. Each document keeps the signature it was signed with.'
          : `By tapping ${action}, I agree this is my electronic signature and initials.`}
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: t.color.destructive }}>
          {error}
        </Text>
      ) : null}
      <Button
        testID="adopt-confirm"
        title={action}
        onPress={() => void finish()}
        disabled={!ready}
        busy={busy}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  segment: { flexDirection: 'row', padding: 2 },
  segmentItem: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  input: { borderWidth: 1, paddingHorizontal: 12, fontSize: 17 },
  preview: { height: 120, justifyContent: 'center', paddingHorizontal: 16 },
  capture: { alignSelf: 'center', paddingHorizontal: 8, paddingVertical: 4 },
  script: { fontSize: 40 },
  scriptInitials: { fontSize: 32 },
  pad: { height: 150, overflow: 'hidden' },
  baseline: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 36,
    borderTopWidth: 1,
    borderStyle: 'dashed',
  },
  hint: { position: 'absolute', alignSelf: 'center', top: 64, fontSize: 15 },
  clear: { position: 'absolute', top: 0, right: 4, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
});
