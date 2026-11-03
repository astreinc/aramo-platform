// Sensitive screens on Android (and any non-iOS platform): nothing is applied. Android
// has no snapshot-only control (FLAG_SECURE would also block screenshots, acceptance
// §12.16), and expo-screen-capture must not load here: its Android module registers a
// screen-capture callback on load, which needs DETECT_SCREEN_CAPTURE (removed by M-A7 §4)
// and crashes the app at start on Android 14+. The iOS hook is sensitiveScreen.ios.ts.
export function useAppSwitcherProtection(_active: boolean): void {
  // Intentionally empty.
}
