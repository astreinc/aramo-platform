// Root component: services, encrypted query-cache persistence, toasts, navigation and
// deep links. Feature screens plug into navigation/RootNavigator.tsx.
import { NavigationContainer, DefaultTheme, type Theme } from '@react-navigation/native';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ServicesProvider } from './app/ServicesContext';
import { createAppServices, type AppServices } from './app/services';
import { ToastProvider } from './components/Toast';
import { DeepLinkRouter } from './navigation/DeepLinkRouter';
import { navigationRef } from './navigation/navigationRef';
import { RootNavigator } from './navigation/RootNavigator';
import { QUERY_CACHE_MAX_AGE_MS, shouldPersistQuery } from './state/queryClient';
import { theme } from './theme';

const navTheme: Theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: theme.color.accent,
    background: theme.color.screen,
    card: theme.color.surface,
    text: theme.color.text,
    border: theme.color.separator,
  },
};

export default function App() {
  const [services] = useState<AppServices>(() => createAppServices());

  useEffect(() => {
    void services.session.restore();
  }, [services]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ServicesProvider services={services}>
          <PersistQueryClientProvider
            client={services.queryClient}
            persistOptions={{
              persister: services.persister,
              maxAge: QUERY_CACHE_MAX_AGE_MS,
              dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
            }}
          >
            <ToastProvider>
              <NavigationContainer ref={navigationRef} theme={navTheme}>
                <DeepLinkRouter />
                <RootNavigator />
              </NavigationContainer>
            </ToastProvider>
          </PersistQueryClientProvider>
        </ServicesProvider>
      </SafeAreaProvider>
      <StatusBar style="dark" />
    </GestureHandlerRootView>
  );
}
