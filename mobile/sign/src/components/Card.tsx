// Card / list surface (handoff §3): iOS white, no border, 12 radius; Android white,
// 1px #E2E1EC, 16 radius.
import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';

export function Card({
  children,
  style,
}: {
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  return (
    <View
      style={[
        { backgroundColor: t.color.surface, borderRadius: t.size.cardRadius, overflow: 'hidden' },
        t.color.surfaceBorder ? { borderWidth: 1, borderColor: t.color.surfaceBorder } : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}
