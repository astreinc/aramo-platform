import { Platform } from 'react-native';

import { androidTheme, iosTheme, type PlatformTheme } from './tokens';

export * from './tokens';

/** The active platform's tokens. iOS values are the default for any other platform. */
export const theme: PlatformTheme = Platform.select({
  ios: iosTheme,
  android: androidTheme,
  default: iosTheme,
});

export function useTheme(): PlatformTheme {
  return theme;
}
