import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import Svg, { Path } from 'react-native-svg';

import { useUnreadCount } from '../features/notifications/queries';
import { usePushLifecycle } from '../features/notifications/usePushLifecycle';
import { AccountScreen } from '../screens/account/AccountScreen';
import { AgreementsScreen } from '../screens/agreements/AgreementsScreen';
import { NotificationsScreen } from '../screens/notifications/NotificationsScreen';
import { useTheme } from '../theme';
import type { MainTabParamList } from './types';

const Tab = createBottomTabNavigator<MainTabParamList>();

function TabIcon({ d, color }: { readonly d: string; readonly color: string }) {
  return (
    <Svg
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d={d} />
    </Svg>
  );
}

const ICONS = {
  Agreements: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6',
  Notifications: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4',
  Account: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
} as const;

export function MainTabs() {
  const t = useTheme();
  // Signed in only: push registration + tap routing, and the server unread badge.
  usePushLifecycle();
  const unread = useUnreadCount().data ?? 0;
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: t.color.accent,
        tabBarInactiveTintColor: t.color.textSecondary,
        tabBarBadgeStyle: { backgroundColor: t.color.badge },
        tabBarIcon: ({ color }) => <TabIcon d={ICONS[route.name]} color={color} />,
      })}
    >
      <Tab.Screen name="Agreements" component={AgreementsScreen} />
      {/* The unread badge comes from GET /v1/sign/me/notifications/unread-count. */}
      <Tab.Screen
        name="Notifications"
        component={NotificationsScreen}
        options={{ tabBarBadge: unread > 0 ? (unread > 99 ? '99+' : unread) : undefined }}
      />
      <Tab.Screen name="Account" component={AccountScreen} />
    </Tab.Navigator>
  );
}
