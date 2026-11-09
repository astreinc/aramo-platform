// The pending-link panels on the sign-in screen (Apple Go-Live A1 L-3, L-7):
//   path 3 (conflict) — "You already have an Aramo account. Confirm it's you.": proof (a)
//     by signing in with another provider, or proof (b) by a code sent to the account email;
//   path 2 (unmatched) — "No Aramo account uses this <Provider> account yet": "I already
//     have an account. Connect it" (proof (a) or (b) with a typed email), or "Create a new
//     account" (the Apple-first signup, parent R-5).
// After a code proof the user signs in with the new provider, which now resolves by subject.
// Proof (a) signs in as the proven user with the handle on the token call; the session then
// replaces this screen.
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { isApiError, type ApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import type { Provider } from '../../auth/authorize';
import { Button } from '../../components/Button';
import { ProviderButton } from '../../components/ProviderButton';
import { TextField } from '../../features/send/ui';
import { useTheme } from '../../theme';
import { LINK_COPY, linkCodeFailure, proofProviders, type PendingLink } from './linkPanelModel';

export interface LinkPanelApi {
  start(handle: string, email?: string): Promise<void>;
  verify(handle: string, code: string): Promise<{ idp: Provider }>;
}

type Step =
  | { k: 'choose' }
  | { k: 'connect' }
  | { k: 'email' }
  | { k: 'code'; sentTo: string | null }
  | { k: 'linked'; idp: Provider };

export interface LinkPanelProps {
  readonly link: PendingLink;
  readonly order: readonly Provider[];
  readonly api: LinkPanelApi;
  readonly onSignIn: (provider: Provider, options?: { linkHandle?: string }) => Promise<unknown>;
  readonly onCreateAccount?: (() => void) | undefined;
  readonly onDone: () => void;
}

const asError = (e: unknown): ApiError | null => (isApiError(e) ? e : null);

export function LinkPanel({ link, order, api, onSignIn, onCreateAccount, onDone }: LinkPanelProps) {
  const t = useTheme();
  const [step, setStep] = useState<Step>(
    link.kind === 'conflict' ? { k: 'connect' } : { k: 'choose' },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [restart, setRestart] = useState(false);

  async function run(key: string, fn: () => Promise<void>): Promise<void> {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  const prove = (p: Provider) =>
    run(`prove-${p}`, async () => {
      try {
        await onSignIn(p, { linkHandle: link.handle });
      } catch (e) {
        const err = asError(e);
        if (err?.reason === 'auth_cancelled') return;
        if (err?.reason === 'link_expired') {
          setError(LINK_COPY.expired(link.idp));
          setRestart(true);
          return;
        }
        setError(err ? refusalMessage(err) : LINK_COPY.generic);
      }
    });

  const sendCode = (typed: string | null) =>
    run('send', async () => {
      if (typed !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typed)) {
        setError(LINK_COPY.emailInvalid);
        return;
      }
      try {
        // In the conflict case the server ignores the email and uses the account's.
        await api.start(link.handle, typed ?? undefined);
        if (step.k === 'code') setNotice(LINK_COPY.resent);
        setStep({ k: 'code', sentTo: typed });
      } catch (e) {
        const err = asError(e);
        if (err === null) return setError(LINK_COPY.generic);
        const f = linkCodeFailure(err, link.idp);
        setError(err.isNetwork ? refusalMessage(err) : f.message);
        setRestart(f.restart);
      }
    });

  const verify = () =>
    run('verify', async () => {
      if (!/^\d{6}$/.test(code)) {
        setError('Enter all 6 digits.');
        return;
      }
      try {
        const r = await api.verify(link.handle, code);
        setStep({ k: 'linked', idp: r.idp });
      } catch (e) {
        const err = asError(e);
        setCode('');
        if (err === null) return setError(LINK_COPY.generic);
        const f = linkCodeFailure(err, link.idp);
        setError(err.isNetwork ? refusalMessage(err) : f.message);
        setRestart(f.restart);
      }
    });

  const continueWith = (p: Provider) =>
    run(`continue-${p}`, async () => {
      try {
        await onSignIn(p);
      } catch (e) {
        const err = asError(e);
        if (err?.reason !== 'auth_cancelled')
          setError(err ? refusalMessage(err) : LINK_COPY.generic);
      }
    });

  const text = {
    color: t.color.textSecondary,
    fontSize: 15,
    lineHeight: 21,
    fontFamily: t.font.family,
  };
  const title = (s: string) => (
    <Text
      accessibilityRole="header"
      style={[styles.title, { color: t.color.text, fontFamily: t.font.family }]}
    >
      {s}
    </Text>
  );
  const errorLine =
    error !== null ? (
      <Text
        testID="link-error"
        accessibilityRole="alert"
        accessibilityLiveRegion="assertive"
        style={[
          styles.center,
          { color: t.color.destructive, fontSize: 15, fontFamily: t.font.family },
        ]}
      >
        {error}
      </Text>
    ) : null;
  const cancel = (
    <Button
      testID="link-cancel"
      title={LINK_COPY.cancel}
      variant="text"
      onPress={onDone}
      disabled={busy !== null}
    />
  );

  if (restart) {
    return (
      <View testID="link-panel" style={styles.gap}>
        {errorLine}
        <Button testID="link-restart" title="OK" onPress={onDone} />
      </View>
    );
  }

  if (step.k === 'linked') {
    return (
      <View testID="link-panel-linked" style={styles.gap}>
        {title(LINK_COPY.linkedTitle(step.idp))}
        <Text style={[text, styles.center]}>{LINK_COPY.linkedBody(step.idp)}</Text>
        {errorLine}
        <ProviderButton
          testID="link-continue"
          provider={step.idp}
          label={LINK_COPY.continueWith(step.idp)}
          busy={busy === `continue-${step.idp}`}
          busyLabel="Signing in…"
          dimmed={busy !== null && busy !== `continue-${step.idp}`}
          onPress={() => void continueWith(step.idp)}
        />
      </View>
    );
  }

  if (step.k === 'code') {
    return (
      <View testID="link-panel-code" style={styles.gap}>
        {title(LINK_COPY.codeTitle)}
        <Text style={text}>
          {step.sentTo === null ? LINK_COPY.codeSentConflict : LINK_COPY.codeSentTyped(step.sentTo)}
        </Text>
        <TextField
          label={LINK_COPY.codeLabel}
          testID="link-code"
          value={code}
          keyboardType="number-pad"
          maxLength={6}
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          onChangeText={(v) => {
            setCode(v.replace(/\D/g, '').slice(0, 6));
            setError(null);
          }}
        />
        {errorLine}
        {notice !== null ? <Text style={text}>{notice}</Text> : null}
        <Button
          testID="link-verify"
          title={LINK_COPY.verify}
          busy={busy === 'verify'}
          disabled={code.length !== 6 || busy !== null}
          onPress={() => void verify()}
        />
        <Button
          testID="link-resend"
          title={LINK_COPY.resend}
          variant="text"
          disabled={busy !== null}
          onPress={() => void sendCode(step.sentTo)}
        />
        {cancel}
      </View>
    );
  }

  if (step.k === 'email') {
    return (
      <View testID="link-panel-email" style={styles.gap}>
        {title(LINK_COPY.unmatchedTitle(link.idp))}
        <TextField
          label={LINK_COPY.emailLabel}
          testID="link-email"
          value={email}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="emailAddress"
          onChangeText={(v) => {
            setEmail(v);
            setError(null);
          }}
        />
        {errorLine}
        <Button
          testID="link-send-code"
          title={LINK_COPY.sendCode}
          busy={busy === 'send'}
          disabled={busy !== null}
          onPress={() => void sendCode(email.trim())}
        />
        {cancel}
      </View>
    );
  }

  if (step.k === 'choose') {
    return (
      <View testID="link-panel-unmatched" style={styles.gap}>
        {title(LINK_COPY.unmatchedTitle(link.idp))}
        <Text style={[text, styles.center]}>{LINK_COPY.unmatchedBody}</Text>
        {link.idp === 'apple' ? (
          <Text testID="link-apple-relay" style={[text, styles.center]}>
            {LINK_COPY.appleRelayHint}
          </Text>
        ) : null}
        <Button
          testID="link-connect"
          title={LINK_COPY.connect}
          onPress={() => setStep({ k: 'connect' })}
        />
        {onCreateAccount !== undefined ? (
          <Button
            testID="link-create"
            title={LINK_COPY.createNew}
            variant="secondary"
            onPress={onCreateAccount}
          />
        ) : null}
        {cancel}
      </View>
    );
  }

  // 'connect': proof (a) or (b).
  const conflict = link.kind === 'conflict';
  return (
    <View testID={conflict ? 'link-panel-conflict' : 'link-panel-connect'} style={styles.gap}>
      {title(conflict ? LINK_COPY.conflictTitle : LINK_COPY.unmatchedTitle(link.idp))}
      <Text style={[text, styles.center]}>{LINK_COPY.conflictBody(link.idp)}</Text>
      {errorLine}
      {proofProviders(link, order).map((p) => (
        <ProviderButton
          key={p}
          testID={`link-prove-${p}`}
          provider={p}
          label={LINK_COPY.proveWith(p)}
          busy={busy === `prove-${p}`}
          busyLabel="Signing in…"
          dimmed={busy !== null && busy !== `prove-${p}`}
          onPress={() => void prove(p)}
        />
      ))}
      <Button
        testID="link-email-code"
        title={LINK_COPY.emailCode}
        variant="secondary"
        busy={busy === 'send'}
        disabled={busy !== null}
        onPress={() => (conflict ? void sendCode(null) : setStep({ k: 'email' }))}
      />
      {cancel}
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { gap: 10 },
  title: { fontSize: 19, fontWeight: '700', textAlign: 'center' },
  center: { textAlign: 'center' },
});
