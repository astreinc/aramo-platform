// Home tab (M-A4 §2). Shell placeholder: the shared top bar over an empty body. The Home
// slice replaces the body (plan banner, Welcome, count chips, Assigned tasks, activity).
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TopBar } from '../../components/TopBar';
import { useFloatingBarSpace } from '../../navigation/FloatingTabBar';
import { useTheme } from '../../theme';

export function HomeScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const barSpace = useFloatingBarSpace();
  return (
    <View
      testID="home-screen"
      style={{ flex: 1, backgroundColor: t.color.screen, paddingTop: insets.top }}
    >
      <ScrollView contentContainerStyle={{ paddingBottom: barSpace }}>
        <TopBar />
      </ScrollView>
    </View>
  );
}
