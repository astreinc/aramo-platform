// Signed-in root (M-A4 §1): two tabs, Home · Agreements, in a floating tab pill with a
// separate + button (FloatingTabBar), inside the shell that owns the side menu.
// Notifications and Account are root-stack screens now (RootNavigator).
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { ShellProvider } from '../features/shell/ShellProvider';
import { useUnreadCount } from '../features/notifications/queries';
import { usePushLifecycle } from '../features/notifications/usePushLifecycle';
import { AgreementsScreen } from '../screens/agreements/AgreementsScreen';
import { HomeScreen } from '../screens/home/HomeScreen';
import { FloatingTabBar } from './FloatingTabBar';
import type { MainTabParamList } from './types';

const Tab = createBottomTabNavigator<MainTabParamList>();

export function MainTabs() {
  // Main stays mounted under every signed-in stack screen, so this is the signed-in
  // root: push registration + tap routing, and the server unread count (it also keeps
  // the app icon badge current; the side menu shows it on Notifications).
  usePushLifecycle();
  useUnreadCount();
  return (
    <ShellProvider>
      <Tab.Navigator
        screenOptions={{ headerShown: false }}
        tabBar={(props) => <FloatingTabBar {...props} />}
      >
        <Tab.Screen name="Home" component={HomeScreen} />
        <Tab.Screen name="Agreements" component={AgreementsScreen} />
      </Tab.Navigator>
    </ShellProvider>
  );
}
