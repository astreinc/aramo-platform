// A placed field on the editor canvas (handoff §4.6 "Field on the canvas"): 1.5px
// border in the signer's colour with a 12% fill; selected: 2px border, 19% fill, a 3px
// ring and an 18px round resize handle at the bottom-right. Tap selects; a drag starts
// after 4px and stays inside the page; the handle resizes down to 14×12 points.
// Screen readers get the field label and the selection panel's move/resize controls
// (handoff §7) instead of gestures.
import { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../../theme';
import type { EditorAction, EditorField } from './editorReducer';
import { FIELD_TYPE_SPECS } from './fieldTypes';
import { editorToScreenBox, type PageSize } from './geometry';
import { createFieldGestures } from './fieldGestures';

const HANDLE = 18;

function alpha(hex: string, a: number): string {
  const n = Math.round(a * 255)
    .toString(16)
    .padStart(2, '0');
  return /^#[0-9a-f]{6}$/i.test(hex) ? `${hex}${n}` : hex;
}

/**
 * M-A12 W1-A — "Sign a document" fills each placed field immediately: the value shown in
 * the box (the adopted signature / initials image, or the text).
 */
export type FieldFill =
  | { readonly kind: 'image'; readonly uri: string }
  | { readonly kind: 'text'; readonly text: string };

export interface FieldBoxProps {
  readonly field: EditorField;
  readonly page: PageSize;
  /** dp per point. */
  readonly scale: number;
  readonly color: string;
  readonly selected: boolean;
  readonly accessibilityLabel: string;
  readonly dispatch: (a: EditorAction) => void;
  /** Lets the canvas stop scrolling while a field is dragged. */
  readonly onGesture?: (active: boolean) => void;
  /** The value to show instead of the type label (self-sign). */
  readonly fill?: FieldFill | null;
}

export function FieldBox({
  field,
  page,
  scale,
  color,
  selected,
  accessibilityLabel,
  dispatch,
  onGesture,
  fill,
}: FieldBoxProps) {
  const t = useTheme();
  const [gestures] = useState(() => createFieldGestures(dispatch, onGesture));
  // The gesture callbacks read the latest field, scale and page.
  useEffect(() => {
    gestures.setLive({ field, scale, page });
  }, [gestures, field, scale, page]);
  const box = editorToScreenBox(field, scale);

  const spec = FIELD_TYPE_SPECS[field.type];
  return (
    <View
      {...gestures.move.panHandlers}
      accessible
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
      accessibilityHint={selected ? undefined : 'Selects the field'}
      onAccessibilityTap={() => dispatch({ type: 'select', key: field.key })}
      style={[
        styles.box,
        {
          left: box.x,
          top: box.y,
          width: box.width,
          height: box.height,
          borderColor: color,
          borderWidth: selected ? 2 : 1.5,
          backgroundColor: alpha(color, selected ? 0.19 : 0.12),
        },
        selected
          ? { shadowColor: color, shadowOpacity: 0.35, shadowRadius: 3, elevation: 2 }
          : null,
      ]}
    >
      {fill?.kind === 'image' ? (
        <Image
          testID={`field-fill-${field.key}`}
          source={{ uri: fill.uri }}
          style={styles.fillImage}
          resizeMode="contain"
          accessibilityIgnoresInvertColors
        />
      ) : fill?.kind === 'text' && fill.text ? (
        <Text
          testID={`field-fill-${field.key}`}
          numberOfLines={1}
          adjustsFontSizeToFit
          style={{ color: '#0B1F6B', fontSize: Math.max(9, Math.min(16, box.height * 0.6)) }}
        >
          {fill.text}
        </Text>
      ) : (
        <Text
          numberOfLines={1}
          style={[styles.label, { color, fontFamily: t.font.family }]}
          maxFontSizeMultiplier={1.4}
        >
          {spec.label}
          {field.required ? ' *' : ''}
        </Text>
      )}
      {selected ? (
        <View
          {...gestures.resize.panHandlers}
          accessible={false}
          importantForAccessibility="no"
          hitSlop={13}
          style={[styles.handle, { backgroundColor: color, borderColor: t.color.white }]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { position: 'absolute', borderRadius: 3, justifyContent: 'center', paddingHorizontal: 4 },
  label: { fontSize: 11, fontWeight: '600' },
  fillImage: { width: '100%', height: '100%' },
  handle: {
    position: 'absolute',
    right: -HANDLE / 2,
    bottom: -HANDLE / 2,
    width: HANDLE,
    height: HANDLE,
    borderRadius: HANDLE / 2,
    borderWidth: 2,
  },
});
