// Toasts (handoff §5): iOS dark pill (rgba(30,30,32,.92), radius 20, 110px from the
// bottom); Android snackbar (#313036, radius 4) above the navigation bar. Both dismiss
// after 2.6 s and are announced to VoiceOver / TalkBack. No animation (reduced motion).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AccessibilityInfo, StyleSheet, Text, View } from 'react-native';

import { TOAST_DURATION_MS, useTheme } from '../theme';

interface ToastApi {
  show(message: string): void;
}

const ToastContext = createContext<ToastApi>({ show: () => undefined });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const t = useTheme();
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((m: string) => {
    if (timer.current) clearTimeout(timer.current);
    setMessage(m);
    AccessibilityInfo.announceForAccessibility(m);
    timer.current = setTimeout(() => setMessage(null), TOAST_DURATION_MS);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const api = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      {message ? (
        <View pointerEvents="none" style={[styles.host, { bottom: t.toast.bottomOffset }]}>
          <View
            accessibilityLiveRegion="polite"
            style={[
              styles.toast,
              { backgroundColor: t.toast.background, borderRadius: t.toast.radius },
              t.platform === 'android' ? styles.snackbar : styles.pill,
            ]}
          >
            <Text style={[styles.text, { fontFamily: t.font.family }]}>{message}</Text>
          </View>
        </View>
      ) : null}
    </ToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  toast: { paddingHorizontal: 16, paddingVertical: 12 },
  pill: { maxWidth: 360 },
  snackbar: { alignSelf: 'stretch' },
  text: { color: '#FFFFFF', fontSize: 15 },
});
