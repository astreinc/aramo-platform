// Sensitive screens (signing, document viewer): blur the iOS app-switcher snapshot
// while the screen is focused (acceptance §12.16). Screen capture itself is NOT blocked
// (accessibility). Android has no snapshot-only control: FLAG_SECURE would also block
// screenshots, so nothing is applied there (see README "Known gaps").
import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as ScreenCapture from 'expo-screen-capture';

export function useAppSwitcherProtection(active: boolean): void {
  useEffect(() => {
    if (!active || Platform.OS !== 'ios') return undefined;
    void ScreenCapture.enableAppSwitcherProtectionAsync(0.9).catch(() => undefined);
    return () => {
      void ScreenCapture.disableAppSwitcherProtectionAsync().catch(() => undefined);
    };
  }, [active]);
}
