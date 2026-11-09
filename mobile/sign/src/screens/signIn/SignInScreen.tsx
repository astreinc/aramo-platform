// Sign in (handoff §4.1, with directive §7 C-9/C-10): federated only. Microsoft, Google and
// (Apple Go-Live R-2 / W4) Apple are shown; Apple first on iOS per Apple's placement
// guidance, as a black "Sign in with Apple" button. A provider the account may not use is
// refused by the server and shown in provider-neutral words. No passwords, no account
// switcher, and still no account creation AT LOGIN (M-A1). M-A11 adds native Personal
// signup as a separate flow BEFORE sign-in: "New to Aramo Sign? Create a free account"
// under the buttons (Android and, with Apple Go-Live W5, iOS). A1 L-3/L-7: a refusal that
// carries a pending-link handle opens the link panel (path 2 / path 3) in place of the
// buttons; the handle stays in this screen's memory only.
import { useNavigation } from '@react-navigation/native';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';

import { isApiError, type ApiError } from '../../api/errors';
import { NO_ACCOUNT_WEB, refusalMessage } from '../../api/refusalMessages';
import { useServices, useSession } from '../../app/ServicesContext';
import type { Provider } from '../../auth/authorize';
import { AramoMark } from '../../components/BrandMarks';
import { Button } from '../../components/Button';
import { ProviderButton } from '../../components/ProviderButton';
import { WEB_LINKS } from '../../config/env';
import { useTheme } from '../../theme';
import { LinkPanel, type LinkPanelApi } from './LinkPanel';
import { pendingLinkFrom, type PendingLink } from './linkPanelModel';

export const SIGN_IN_COPY = {
  title: 'Aramo Sign',
  subtitle: 'Send, manage and sign agreements from anywhere.',
  microsoft: 'Continue with Microsoft',
  google: 'Continue with Google',
  apple: 'Sign in with Apple',
  busy: 'Signing in…',
  footnote:
    'Signing something you were sent? Open the link in your email. You don’t need an account.',
  expired: 'Your session ended. Sign in again.',
  newHere: 'New to Aramo Sign?',
  createAccount: 'Create a free account',
} as const;

const LABELS: Record<Provider, string> = {
  microsoft: SIGN_IN_COPY.microsoft,
  google: SIGN_IN_COPY.google,
  apple: SIGN_IN_COPY.apple,
};

/** Button order: Apple first on iOS (Apple's guidance); last elsewhere. */
export function providerOrder(platform: string): readonly Provider[] {
  return platform === 'ios' ? ['apple', 'microsoft', 'google'] : ['microsoft', 'google', 'apple'];
}

export interface SignInViewProps {
  readonly onSignIn: (provider: Provider, options?: { linkHandle?: string }) => Promise<unknown>;
  readonly onOpenLink: (url: string) => void;
  readonly sessionExpired?: boolean;
  /** Opens native Personal signup (M-A11); absent where signup isn't offered. */
  readonly onCreateAccount?: () => void;
  /** A1 L-4 proof (b) (email code); without it a pending link shows no panel. */
  readonly linkApi?: LinkPanelApi;
}

/** Presentational sign-in (no services), so it renders in tests. */
export function SignInView({
  onSignIn,
  onOpenLink,
  sessionExpired,
  onCreateAccount,
  linkApi,
}: SignInViewProps) {
  const t = useTheme();
  const ios = t.platform === 'ios';
  const order = providerOrder(t.platform);
  const [busy, setBusy] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(sessionExpired ? SIGN_IN_COPY.expired : null);
  const [noAccount, setNoAccount] = useState(false);
  const [link, setLink] = useState<PendingLink | null>(null);

  async function start(provider: Provider): Promise<void> {
    setBusy(provider);
    setError(null);
    setNoAccount(false);
    try {
      await onSignIn(provider);
    } catch (e) {
      const err = isApiError(e) ? (e as ApiError) : null;
      const pending = linkApi !== undefined ? pendingLinkFrom(err, provider) : null;
      if (pending !== null) {
        setLink(pending);
      } else if (err?.reason === 'user_not_provisioned') {
        // M-A11 §1: offer the native signup; without it, point to the web as before.
        setNoAccount(onCreateAccount !== undefined);
        setError(onCreateAccount !== undefined ? refusalMessage(err) : NO_ACCOUNT_WEB);
      } else if (err?.reason !== 'auth_cancelled')
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
        {link !== null && linkApi !== undefined ? (
          <LinkPanel
            link={link}
            order={order}
            api={linkApi}
            onSignIn={onSignIn}
            onCreateAccount={onCreateAccount}
            onDone={() => setLink(null)}
          />
        ) : null}
        {link === null
          ? order.map((id) => (
              <ProviderButton
                key={id}
                testID={`sign-in-${id}`}
                provider={id}
                label={LABELS[id]}
                busy={busy === id}
                busyLabel={SIGN_IN_COPY.busy}
                dimmed={busy !== null && busy !== id}
                onPress={() => void start(id)}
              />
            ))
          : null}
        {link === null && onCreateAccount !== undefined && noAccount ? (
          <Button
            title={SIGN_IN_COPY.createAccount}
            onPress={onCreateAccount}
            disabled={busy !== null}
            testID="sign-in-no-account-create"
          />
        ) : null}
        {link === null && onCreateAccount !== undefined && !noAccount ? (
          <View style={styles.newHere}>
            <Text style={{ color: t.color.textSecondary, fontSize: 15, fontFamily: t.font.family }}>
              {SIGN_IN_COPY.newHere}
            </Text>
            <Pressable
              testID="sign-in-create-account"
              onPress={onCreateAccount}
              disabled={busy !== null}
              accessibilityRole="button"
              accessibilityLabel={SIGN_IN_COPY.createAccount}
              hitSlop={12}
              style={styles.link}
            >
              <Text
                style={{
                  color: t.color.accent,
                  fontSize: 15,
                  fontWeight: '600',
                  fontFamily: t.font.family,
                }}
              >
                {SIGN_IN_COPY.createAccount}
              </Text>
            </Pressable>
          </View>
        ) : null}
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
  const { signIn, nativeAuth } = useServices();
  const { cause } = useSession();
  const navigation = useNavigation();
  const linkApi: LinkPanelApi = {
    start: (handle, email) =>
      nativeAuth.linkEmailStart(email ? { link_handle: handle, email } : { link_handle: handle }),
    verify: (handle, code) => nativeAuth.linkEmailVerify({ link_handle: handle, code }),
  };
  return (
    <SignInView
      onSignIn={signIn}
      sessionExpired={cause === 'expired'}
      // Apple Go-Live W5: native signup on iOS too (App Attest), not only Android.
      onCreateAccount={() => navigation.navigate('Signup')}
      linkApi={linkApi}
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
  footnote: { fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 8 },
  links: { flexDirection: 'row', justifyContent: 'center', gap: 16, marginTop: 2 },
  newHere: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
  },
  link: { minHeight: 32, justifyContent: 'center' },
});
