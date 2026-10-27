// The + button's overlay (M-A4 §1.3; handoff §2A "+ button"): dims the page and stacks
// white pills above the button — Request signatures, and Sign a document ONLY when
// FEATURES.selfSign is on. Both open the Send flow with their intent. While the server
// says the session cannot send (`can_send` false) the actions are disabled and show
// the server-derived reason.
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { DISABLED_OPACITY, useTheme } from '../../theme';
import type { SendFlowIntent } from '../../navigation/types';
import { ShellIcon } from './icons';
import type { PlusAction } from './shellModel';

export function PlusMenu({
  open,
  actions,
  bottom,
  onClose,
  onPick,
}: {
  readonly open: boolean;
  readonly actions: readonly PlusAction[];
  /** Distance from the screen bottom to the + button's bottom edge. */
  readonly bottom: number;
  readonly onClose: () => void;
  readonly onPick: (intent: SendFlowIntent) => void;
}) {
  const t = useTheme();
  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <Pressable
        testID="plus-scrim"
        onPress={onClose}
        style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.3)' }]}
        accessible={false}
        importantForAccessibility="no"
      />
      <View
        accessibilityViewIsModal
        onAccessibilityEscape={onClose}
        style={[styles.stack, { bottom: bottom + PLUS_SIZE + 12 }]}
      >
        {actions.map((a) => (
          <Pressable
            key={a.intent}
            testID={`plus-${a.intent}`}
            onPress={() => onPick(a.intent)}
            disabled={a.disabled}
            accessibilityRole="button"
            accessibilityLabel={a.label}
            accessibilityHint={a.reason ?? undefined}
            accessibilityState={{ disabled: a.disabled }}
            style={[
              styles.pill,
              { backgroundColor: t.color.white, opacity: a.disabled ? DISABLED_OPACITY : 1 },
            ]}
          >
            <ShellIcon
              name={a.intent === 'self' ? 'selfSign' : 'request'}
              size={22}
              color={t.color.text}
            />
            <Text
              style={{
                color: t.color.text,
                fontSize: 16.5,
                fontWeight: '500',
                fontFamily: t.font.family,
              }}
            >
              {a.label}
            </Text>
          </Pressable>
        ))}
        {actions.some((a) => a.disabled && a.reason) ? (
          <View testID="plus-reason" style={[styles.reason, { backgroundColor: t.color.white }]}>
            <Text
              style={{ color: t.color.textSecondary, fontSize: 13.5, fontFamily: t.font.family }}
            >
              {actions.find((a) => a.disabled && a.reason)?.reason}
            </Text>
          </View>
        ) : null}
      </View>
      <Pressable
        testID="plus-close"
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close"
        accessibilityState={{ expanded: true }}
        style={[styles.plus, { bottom, backgroundColor: t.color.accent }]}
      >
        <ShellIcon name="close" size={28} color={t.color.white} />
      </Pressable>
    </Modal>
  );
}

export const PLUS_SIZE = 62;

const styles = StyleSheet.create({
  stack: { position: 'absolute', right: 16, left: 16, alignItems: 'flex-end', gap: 12 },
  pill: {
    height: 54,
    borderRadius: 27,
    paddingLeft: 18,
    paddingRight: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  reason: { borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, maxWidth: 320 },
  plus: {
    position: 'absolute',
    right: 16,
    width: PLUS_SIZE,
    height: PLUS_SIZE,
    borderRadius: PLUS_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
