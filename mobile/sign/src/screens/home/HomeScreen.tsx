// Home tab (M-A4 §2): the shared top bar over the Home body (plan banner, Welcome, count
// chips, Assigned tasks, Agreement activity). HomeBody owns its scroll view and
// pull-to-refresh, and leaves room at the bottom for the floating tab pill.
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TopBar } from '../../components/TopBar';
import { HomeBody } from '../../features/home/HomeBody';
import { useTheme } from '../../theme';

export function HomeScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      testID="home-screen"
      style={{ flex: 1, backgroundColor: t.color.screen, paddingTop: insets.top }}
    >
      <TopBar />
      <HomeBody />
    </View>
  );
}
