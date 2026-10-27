// Floating bottom navigation (M-A4 §1.1; handoff §2A "Bottom navigation"), both
// platforms: a 62px tab pill holding Home · Agreements, and a separate 62px + button to
// its right that opens the + overlay (features/shell/PlusMenu.tsx). The bar floats over
// the screen content: tab screens pad their scroll content by useFloatingBarSpace().
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FEATURES } from '../config/features';
import { allowanceModel } from '../features/inbox/allowance';
import { useBillingAccount, useSenderContext } from '../features/inbox/queries';
import { ShellIcon } from '../features/shell/icons';
import { PLUS_SIZE, PlusMenu } from '../features/shell/PlusMenu';
import { plusActions } from '../features/shell/shellModel';
import { useTheme } from '../theme';
import type { MainTabParamList } from './types';

const BAR_HEIGHT = 62;
const BAR_TOP_PAD = 10;

const TAB_META: Record<keyof MainTabParamList, { label: string; icon: 'home' | 'agreements' }> = {
  Home: { label: 'Home', icon: 'home' },
  Agreements: { label: 'Agreements', icon: 'agreements' },
};

function barBottom(insetBottom: number): number {
  return Math.max(insetBottom, 12) + 6;
}

/** Bottom padding a tab screen's scroll content needs to clear the floating bar. */
export function useFloatingBarSpace(): number {
  const insets = useSafeAreaInsets();
  return barBottom(insets.bottom) + BAR_HEIGHT + BAR_TOP_PAD + 12;
}

export function FloatingTabBar({ state, navigation }: BottomTabBarProps) {
  const t = useTheme();
  const ios = t.platform === 'ios';
  const insets = useSafeAreaInsets();
  const bottom = barBottom(insets.bottom);
  const [plusOpen, setPlusOpen] = useState(false);
  const ctx = useSenderContext();
  const billing = useBillingAccount();
  const canSend = ctx.data?.can_send === true;
  const actions = plusActions({
    canSend,
    allowance: allowanceModel(billing.data ?? null),
    selfSign: FEATURES.selfSign,
  });

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { paddingBottom: bottom, paddingTop: BAR_TOP_PAD }]}
    >
      <View
        accessibilityRole="tablist"
        style={[styles.pill, ios ? styles.iosShadow : styles.androidShadow]}
      >
        {state.routes.map((route, index) => {
          const focused = state.index === index;
          const meta = TAB_META[route.name as keyof MainTabParamList];
          const color = focused ? t.color.accent : t.color.text;
          const onPress = () => {
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
          };
          return (
            <Pressable
              key={route.key}
              testID={`tab-${route.name}`}
              onPress={onPress}
              onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
              accessibilityRole="tab"
              accessibilityLabel={meta.label}
              accessibilityState={{ selected: focused }}
              style={[
                styles.tab,
                {
                  backgroundColor: focused
                    ? ios
                      ? 'rgba(118,118,128,0.14)'
                      : t.color.tint
                    : 'transparent',
                },
              ]}
            >
              <ShellIcon name={meta.icon} size={23} color={color} />
              <Text
                numberOfLines={1}
                style={{
                  color,
                  fontSize: 11.5,
                  fontWeight: focused ? '700' : '500',
                  fontFamily: t.font.family,
                }}
              >
                {meta.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Pressable
        testID="plus-open"
        onPress={() => setPlusOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="New"
        accessibilityState={{ expanded: false }}
        style={[styles.plus, { backgroundColor: t.color.accent }]}
      >
        <ShellIcon name="plus" size={28} color={t.color.white} />
      </Pressable>
      <PlusMenu
        open={plusOpen}
        actions={actions}
        bottom={bottom}
        onClose={() => setPlusOpen(false)}
        onPick={(intent) => {
          setPlusOpen(false);
          navigation.navigate('SendFlow', { intent });
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
  },
  pill: {
    flex: 1,
    flexDirection: 'row',
    height: BAR_HEIGHT,
    borderRadius: BAR_HEIGHT / 2,
    backgroundColor: 'rgba(255,255,255,0.95)',
    padding: 4,
  },
  iosShadow: {
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 6 },
  },
  androidShadow: { elevation: 6 },
  tab: {
    flex: 1,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  plus: {
    width: PLUS_SIZE,
    height: PLUS_SIZE,
    borderRadius: PLUS_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#022AC0',
    shadowOpacity: 0.6,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
});
