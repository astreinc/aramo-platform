// Puts the signing page's "Finish" text button in the native navigation bar (handoff
// §4.4: 40% opacity until everything required is done).
import { useNavigation } from '@react-navigation/native';
import { useCallback } from 'react';
import { Pressable, Text } from 'react-native';

import { DISABLED_OPACITY, useTheme } from '../../theme';

export type HeaderFinish = { visible: boolean; enabled: boolean; onPress: () => void } | null;

export function useHeaderFinish(): (h: HeaderFinish) => void {
  const navigation = useNavigation();
  const t = useTheme();
  return useCallback(
    (h: HeaderFinish) => {
      navigation.setOptions({
        headerRight: h?.visible
          ? () => (
              <Pressable
                testID="header-finish"
                onPress={h.onPress}
                accessibilityRole="button"
                accessibilityLabel="Finish"
                accessibilityState={{ disabled: !h.enabled }}
                hitSlop={12}
                style={{
                  opacity: h.enabled ? 1 : DISABLED_OPACITY,
                  minHeight: t.size.minTouch,
                  justifyContent: 'center',
                }}
              >
                <Text
                  style={{
                    color: t.color.accent,
                    fontSize: t.button.primary.fontSize,
                    fontWeight: '600',
                  }}
                >
                  Finish
                </Text>
              </Pressable>
            )
          : undefined,
      });
    },
    [navigation, t],
  );
}
