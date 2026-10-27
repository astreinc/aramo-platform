// "‹ Home" back link for the side-menu stack screens (M-A4 §1.5): Notifications, Account,
// Templates. Returns to the Home tab (navigating to Main pops back to it).
import { useNavigation } from '@react-navigation/native';
import { Pressable, Text } from 'react-native';

import { useTheme } from '../../theme';
import { ShellIcon } from './icons';

export function HomeBackLink() {
  const t = useTheme();
  const ios = t.platform === 'ios';
  const navigation = useNavigation();
  return (
    <Pressable
      testID="back-home"
      onPress={() => navigation.navigate('Main', { screen: 'Home' })}
      accessibilityRole="button"
      accessibilityLabel="Back to Home"
      hitSlop={6}
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: t.size.minTouch,
        paddingHorizontal: 8,
        marginLeft: 4,
      }}
    >
      <ShellIcon name="chevronLeft" size={20} color={t.color.accent} strokeWidth={2.4} />
      <Text
        style={{
          color: t.color.accent,
          fontSize: ios ? 17 : 15,
          fontWeight: ios ? '400' : '500',
          fontFamily: t.font.family,
        }}
      >
        Home
      </Text>
    </Pressable>
  );
}
