// Swipe left on a row to reveal its actions (handoff §2A "Swipe left"; M-A4 §3.5, §3.6).
// Generalises the earlier swipe-to-delete: the row slides to show 76 pt action buttons
// (icon + label) for the actions swipeActionsFor() returned. Swiping right or tapping an
// action closes it, and the screen keeps only one row open at a time (`onOpen`).
// The same actions are VoiceOver / TalkBack custom actions on the row itself
// (rowA11yActions), so no action is swipe-only. Destructive actions confirm first:
// Delete here (Alert), Void through the reason sheet (useRowActions).
import { useRef, type ReactNode } from 'react';
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import Svg, { Path } from 'react-native-svg';

import { useTheme } from '../../theme';
import { actionA11yLabel, type SwipeAction, type SwipeActionKind } from './rowActionRules';

export const DELETE_DRAFT_TITLE = 'Delete this draft?';
export const DELETE_DRAFT_BODY =
  'Its documents, recipients and fields are removed. This can’t be undone.';

export function confirmDeleteDraft(onConfirm: () => void, onCancel?: () => void): void {
  Alert.alert(DELETE_DRAFT_TITLE, DELETE_DRAFT_BODY, [
    { text: 'Cancel', style: 'cancel', onPress: onCancel },
    { text: 'Delete', style: 'destructive', onPress: onConfirm },
  ]);
}

const ICON: Record<SwipeActionKind, string> = {
  sign: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM14 6l4 4',
  remind: 'M18 16v-5a6 6 0 1 0-12 0v5l-2 2h16zM10 21h4',
  void: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM5.6 5.6l12.8 12.8',
  edit: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM14 6l4 4',
  delete: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  share: 'M12 3v13M7 8l5-5 5 5M5 14v6h14v-6',
};

const NEUTRAL = '#5C6770';

/** The row's custom accessibility actions (named by kind, labelled for the reader). */
export function rowA11yActions(
  actions: readonly SwipeAction[],
  subject: string,
  onAction: (kind: SwipeActionKind) => void,
): {
  accessibilityActions: AccessibilityActionInfo[];
  onAccessibilityAction: (e: AccessibilityActionEvent) => void;
} {
  return {
    accessibilityActions: actions.map((a) => ({
      name: a.kind,
      label: actionA11yLabel(a, subject),
    })),
    onAccessibilityAction: (e) => {
      const hit = actions.find((a) => a.kind === e.nativeEvent.actionName);
      if (hit) onAction(hit.kind);
    },
  };
}

export interface SwipeHandle {
  close(): void;
}

export function SwipeActions({
  actions,
  subject,
  onAction,
  onOpen,
  children,
}: {
  readonly actions: readonly SwipeAction[];
  /** What the row is, for the screen reader ("Void <subject>"). */
  readonly subject: string;
  readonly onAction: (kind: SwipeActionKind) => void;
  /** Called when this row opens, with a handle to close it (one open row at a time). */
  readonly onOpen?: (handle: SwipeHandle) => void;
  readonly children: ReactNode;
}) {
  const t = useTheme();
  const ref = useRef<Swipeable>(null);
  if (actions.length === 0) return <>{children}</>;
  const bg = (a: SwipeAction) =>
    a.tone === 'accent' ? t.color.accent : a.tone === 'destructive' ? t.color.destructive : NEUTRAL;
  return (
    <Swipeable
      ref={ref}
      friction={2}
      rightThreshold={36}
      overshootRight={false}
      onSwipeableWillOpen={() => onOpen?.({ close: () => ref.current?.close() })}
      renderRightActions={() => (
        <View style={styles.actions}>
          {actions.map((a) => (
            <Pressable
              key={a.kind}
              testID={`swipe-${a.kind}`}
              accessibilityRole="button"
              accessibilityLabel={actionA11yLabel(a, subject)}
              onPress={() => {
                ref.current?.close();
                onAction(a.kind);
              }}
              style={[styles.action, { backgroundColor: bg(a) }]}
            >
              <Svg
                width={20}
                height={20}
                viewBox="0 0 24 24"
                fill="none"
                stroke="#FFFFFF"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <Path d={ICON[a.kind]} />
              </Svg>
              <Text style={styles.text} maxFontSizeMultiplier={1.4}>
                {a.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    >
      {children}
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row' },
  action: { width: 76, alignItems: 'center', justifyContent: 'center', gap: 4, minHeight: 48 },
  text: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
});
