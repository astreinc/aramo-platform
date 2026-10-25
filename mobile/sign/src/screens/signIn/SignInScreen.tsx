// Sign in (handoff §4.1, with directive §7 C-9/C-10): federated only, Microsoft and
// Google both shown (Business may use Microsoft; a Personal Microsoft attempt is refused
// by the server and shown as "Personal accounts sign in with Google."). No passwords, no
// account creation, no account switcher.
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';

import { isApiError, type ApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import { useServices, useSession } from '../../app/ServicesContext';
import type { Provider } from '../../auth/authorize';
import { AramoMark, GoogleLogo, MicrosoftLogo } from '../../components/BrandMarks';
import { WEB_LINKS } from '../../config/env';
import { useTheme } from '../../theme';

export const SIGN_IN_COPY = {
  title: 'Aramo Sign',
  subtitle: 'Send, manage and sign agreements from anywhere.',
  microsoft: 'Continue with Microsoft',
  google: 'Continue with Google',
  busy: 'Signing in…',
  footnote:
    'Signing something you were sent? Open the link in your email. You don’t need an account.',
  expired: 'Your session ended. Sign in again.',
} as const;

const PROVIDERS: readonly { readonly id: Provider; readonly label: string }[] = [
  { id: 'microsoft', label: SIGN_IN_COPY.microsoft },
  { id: 'google', label: SIGN_IN_COPY.google },
];

export interface SignInViewProps {
  readonly onSignIn: (provider: Provider) => Promise<void>;
  readonly onOpenLink: (url: string) => void;
  readonly sessionExpired?: boolean;
}

/** Presentational sign-in (no services), so it renders in tests. */
export function SignInView({ onSignIn, onOpenLink, sessionExpired }: SignInViewProps) {
  const t = useTheme();
  const ios = t.platform === 'ios';
  const [busy, setBusy] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(sessionExpired ? SIGN_IN_COPY.expired : null);

  async function start(provider: Provider): Promise<void> {
    setBusy(provider);
    setError(null);
    try {
      await onSignIn(provider);
    } catch (e) {
      const err = isApiError(e) ? (e as ApiError) : null;
      if (err?.reason !== 'auth_cancelled')
        setError(
          err ? refusalMessage(err) : refusalMessage({ reason: 'unknown', code: 'unknown' }),
        );
    } finally {
      setBusy(null);
    }
  }

  return (
    <SafeAreaView
      style={[styles.fill, { backgroundColor: t.color.white }]}
      edges={['top', 'bottom']}
    >
      <View style={styles.hero}>
        <View
          style={[
            styles.tile,
            { backgroundColor: t.color.accent, borderRadius: t.size.appTileRadius },
            ios ? styles.tileShadowIos : styles.tileShadowAndroid,
          ]}
        >
          <AramoMark size={52} />
        </View>
        <Text
          accessibilityRole="header"
          style={[
            { color: t.color.text, fontFamily: t.font.family },
            t.type.appTitle,
            ios ? styles.titleIos : null,
          ]}
        >
          {SIGN_IN_COPY.title}
        </Text>
        <Text
          style={[styles.subtitle, { color: t.color.textSecondary, fontFamily: t.font.family }]}
        >
          {SIGN_IN_COPY.subtitle}
        </Text>
      </View>

      <View style={styles.actions}>
        {error ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
            style={[styles.error, { color: t.color.destructive, fontFamily: t.font.family }]}
          >
            {error}
          </Text>
        ) : null}
        {PROVIDERS.map((p) => {
          const isBusy = busy === p.id;
          const disabled = busy !== null;
          return (
            <Pressable
              key={p.id}
              testID={`sign-in-${p.id}`}
              onPress={() => void start(p.id)}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel={isBusy ? SIGN_IN_COPY.busy : p.label}
              accessibilityState={{ disabled, busy: isBusy }}
              android_ripple={ios ? undefined : { color: t.color.fill }}
              style={({ pressed }) => [
                styles.provider,
                {
                  height: t.button.signIn.height,
                  borderRadius: t.button.signIn.radius,
                  borderColor: t.color.signInBorder,
                  opacity: busy !== null && !isBusy ? 0.5 : 1,
                },
                pressed && ios ? { backgroundColor: t.color.fill } : null,
              ]}
            >
              {p.id === 'microsoft' ? <MicrosoftLogo size={18} /> : <GoogleLogo size={18} />}
              <Text
                maxFontSizeMultiplier={1.6}
                style={{
                  color: t.color.text,
                  fontFamily: t.font.family,
                  fontSize: t.button.signIn.fontSize,
                  fontWeight: t.button.signIn.fontWeight,
                }}
              >
                {isBusy ? SIGN_IN_COPY.busy : p.label}
              </Text>
            </Pressable>
          );
        })}
        <Text
          style={[styles.footnote, { color: t.color.textSecondary, fontFamily: t.font.family }]}
        >
          {SIGN_IN_COPY.footnote}
        </Text>
        <View style={styles.links}>
          {(
            [
              ['Terms', WEB_LINKS.terms],
              ['Privacy', WEB_LINKS.privacy],
              ['Help', WEB_LINKS.help],
            ] as const
          ).map(([label, url]) => (
            <Pressable
              key={label}
              onPress={() => onOpenLink(url)}
              accessibilityRole="link"
              hitSlop={12}
              style={styles.link}
            >
              <Text
                style={{ color: t.color.textTertiary, fontSize: 12.5, fontFamily: t.font.family }}
              >
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </SafeAreaView>
  );
}

export function SignInScreen() {
  const { signIn } = useServices();
  const { cause } = useSession();
  return (
    <SignInView
      onSignIn={signIn}
      sessionExpired={cause === 'expired'}
      onOpenLink={(url) => void WebBrowser.openBrowserAsync(url).catch(() => undefined)}
    />
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: Platform.OS === 'ios' ? 30 : 24,
    paddingBottom: 12,
  },
  hero: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  tile: { width: 84, height: 84, alignItems: 'center', justifyContent: 'center' },
  // "a soft blue shadow below" (0 10px 26px -10px rgba(2,42,192,.6))
  tileShadowIos: {
    shadowColor: '#022AC0',
    shadowOpacity: 0.6,
    shadowRadius: 13,
    shadowOffset: { width: 0, height: 10 },
  },
  tileShadowAndroid: { elevation: 8, shadowColor: '#022AC0' },
  titleIos: { letterSpacing: -0.3 },
  subtitle: { fontSize: 16, lineHeight: 23, maxWidth: 270, textAlign: 'center' },
  actions: { gap: 10 },
  error: { fontSize: 15, textAlign: 'center', marginBottom: 4 },
  provider: {
    borderWidth: 1,
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  footnote: { fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 8 },
  links: { flexDirection: 'row', justifyContent: 'center', gap: 16, marginTop: 2 },
  link: { minHeight: 32, justifyContent: 'center' },
});
