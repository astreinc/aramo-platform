// SMS-CONSENT-1 §2 (R-3) — Account → Text messages in the app (the web has the same flow in
// Settings): verify a mobile number with a texted code, then a SEPARATE box with the consent
// wording, never ticked for the person; Turn off and Remove number. Shown only while the
// server says texts are available (R-8: off today). The optional step after signup
// (SmsSignupStep, on Home) opens the same flow with channel SIGNUP.
import { STEP_UP_CODE_LENGTH, normalizeStepUpCode } from '@aramo/sign-client';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { isApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import type { WorkspaceClient } from '../../api/workspaceClient';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { useTheme } from '../../theme';
import { CheckRow, SectionTitle } from '../inbox/ui';
import { PHONE_HINT, validPhone } from '../send/recipientRoles';
import { ErrorText, TextField } from '../send/ui';
import {
  clearSmsSignupOffer,
  loadSmsConsent,
  removeSmsConsent,
  saveSmsConsent,
  sendSmsConsentCode,
  smsSignupOfferPending,
  verifySmsConsentCode,
  type SmsConsentChannel,
  type SmsConsentStatus,
} from './smsConsent';
import {
  SMS_CONSENT_WORDING,
  SMS_CONSENT_WORDING_VERSION,
  SMS_SIGNUP_STEP_SKIP,
  SMS_SIGNUP_STEP_TITLE,
} from './smsConsentCopy';

const messageOf = (e: unknown): string =>
  isApiError(e) ? refusalMessage(e) : refusalMessage({ reason: '', code: '' });

function useSmsConsent(
  workspace: WorkspaceClient,
): [SmsConsentStatus | null, (s: SmsConsentStatus) => void] {
  const [status, setStatus] = useState<SmsConsentStatus | null>(null);
  useEffect(() => {
    let live = true;
    loadSmsConsent(workspace)
      .then((s) => {
        if (live) setStatus(s);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workspace]);
  return [status, setStatus];
}

/** The number, code and consent steps (shared by Account and the signup step). */
export function SmsConsentFlow({
  workspace,
  status,
  channel,
  onChange,
}: {
  readonly workspace: WorkspaceClient;
  readonly status: SmsConsentStatus;
  readonly channel: SmsConsentChannel;
  readonly onChange: (s: SmsConsentStatus) => void;
}) {
  const t = useTheme();
  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [agree, setAgree] = useState(false);
  const [sentTo, setSentTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wording =
    status.wording !== null && status.wording.trim() !== '' ? status.wording : SMS_CONSENT_WORDING;
  const version = status.wording_version ?? SMS_CONSENT_WORDING_VERSION;
  const phoneBad = phone.trim() !== '' && !validPhone(phone);
  const body = {
    color: t.color.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: t.font.family,
  };

  async function run(work: () => Promise<unknown>, after?: () => void): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await work();
      after?.();
      onChange(await loadSmsConsent(workspace));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function sendCode(): Promise<void> {
    if (phoneBad || phone.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const r = await sendSmsConsentCode(workspace, phone);
      setSentTo(r.phone_masked ?? phone.trim());
      setCode('');
      setStage('code');
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const remove = () =>
    void run(
      () => removeSmsConsent(workspace),
      () => setAgree(false),
    );

  if (!status.phone_verified) {
    return (
      <View style={styles.gap} testID="sms-consent-flow">
        {stage === 'phone' ? (
          <>
            <TextField
              label="Mobile number"
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              autoComplete="tel"
              textContentType="telephoneNumber"
              placeholder="+14155550123"
              error={phoneBad ? PHONE_HINT : null}
              testID="sms-consent-phone"
            />
            <Button
              title="Text me a code"
              onPress={() => void sendCode()}
              busy={busy}
              disabled={busy || phone.trim() === '' || phoneBad}
              testID="sms-consent-send-code"
            />
          </>
        ) : (
          <>
            <Text style={body} accessibilityLiveRegion="polite">
              {`We texted a code to ${sentTo}.`}
            </Text>
            <TextField
              label="Code"
              value={code}
              onChangeText={(v) => setCode(normalizeStepUpCode(v))}
              keyboardType="number-pad"
              autoComplete="sms-otp"
              textContentType="oneTimeCode"
              maxLength={STEP_UP_CODE_LENGTH}
              testID="sms-consent-code"
            />
            <Button
              title="Verify"
              onPress={() =>
                void run(
                  () => verifySmsConsentCode(workspace, code),
                  () => {
                    setStage('phone');
                    setPhone('');
                    setCode('');
                    setAgree(false);
                  },
                )
              }
              busy={busy}
              disabled={busy || code.length !== STEP_UP_CODE_LENGTH}
              testID="sms-consent-verify"
            />
            <Button
              title="Use another number"
              variant="text"
              onPress={() => setStage('phone')}
              disabled={busy}
              testID="sms-consent-change-number"
            />
          </>
        )}
        <ErrorText>{error}</ErrorText>
      </View>
    );
  }

  return (
    <View style={styles.gap} testID="sms-consent-flow">
      <Text
        style={body}
        testID="sms-consent-number"
      >{`Your number: ${status.phone_masked ?? '—'} (verified)`}</Text>
      {status.consented ? (
        <>
          <Text style={body} accessibilityLiveRegion="polite" testID="sms-consent-on">
            Texts are on.
          </Text>
          <Button
            title="Turn off"
            variant="secondary"
            onPress={() =>
              void run(() =>
                saveSmsConsent(workspace, { consented: false, wording_version: version, channel }),
              )
            }
            disabled={busy}
            testID="sms-consent-turn-off"
          />
          <Button
            title="Remove number"
            variant="text"
            onPress={remove}
            disabled={busy}
            testID="sms-consent-remove"
          />
        </>
      ) : (
        <>
          <CheckRow
            checked={agree}
            onToggle={() => setAgree((v) => !v)}
            accessibilityLabel={wording}
            testID="sms-consent-agree"
          >
            <Text style={[body, { color: t.color.text, flex: 1 }]} testID="sms-consent-wording">
              {wording}
            </Text>
          </CheckRow>
          <Button
            title="Turn on texts"
            onPress={() =>
              void run(() =>
                saveSmsConsent(workspace, { consented: true, wording_version: version, channel }),
              )
            }
            busy={busy}
            disabled={busy || !agree}
            testID="sms-consent-save"
          />
          <Button
            title="Remove number"
            variant="text"
            onPress={remove}
            disabled={busy}
            testID="sms-consent-remove"
          />
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </View>
  );
}

/** Account → Text messages (channel APP). Renders nothing unless texts are available. */
export function TextMessagesSection({ workspace }: { readonly workspace: WorkspaceClient }) {
  const t = useTheme();
  const [status, setStatus] = useSmsConsent(workspace);
  if (status?.available !== true) return null;
  return (
    <View testID="account-text-messages">
      <SectionTitle>Text messages</SectionTitle>
      <Card style={styles.card}>
        <Text
          style={{
            color: t.color.textSecondary,
            fontSize: 14,
            lineHeight: 20,
            fontFamily: t.font.family,
          }}
        >
          Get signing requests, reminders and signing codes by text from people who send you
          documents.
        </Text>
        <SmsConsentFlow workspace={workspace} status={status} channel="APP" onChange={setStatus} />
      </Card>
    </View>
  );
}

/**
 * The optional step after signup (R-3), on Home: shown once after the sign-in that follows
 * a signup in this app session, while texts are available and not already on. "Not now"
 * skips it.
 */
export function SmsSignupStep({ workspace }: { readonly workspace: WorkspaceClient }) {
  const t = useTheme();
  const [pending, setPending] = useState(smsSignupOfferPending);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SmsConsentStatus | null>(null);
  // Offered once: when it is not shown (texts unavailable, or already on) it is not kept for later.
  const [offered] = useState(pending);
  useEffect(() => {
    if (!offered) return undefined;
    let live = true;
    loadSmsConsent(workspace)
      .then((s) => {
        if (!live) return;
        if (s.available !== true || s.consented) {
          clearSmsSignupOffer();
          setPending(false);
        } else setStatus(s);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workspace, offered]);
  if (!pending || status === null) return null;
  const skip = () => {
    clearSmsSignupOffer();
    setPending(false);
  };
  return (
    <Card style={[styles.card, styles.step]}>
      <View style={styles.gap} testID="sms-signup-step">
        <Text
          accessibilityRole="header"
          style={[styles.title, { color: t.color.text, fontFamily: t.font.family }]}
        >
          {SMS_SIGNUP_STEP_TITLE}
        </Text>
        {open ? (
          <>
            <SmsConsentFlow
              workspace={workspace}
              status={status}
              channel="SIGNUP"
              onChange={setStatus}
            />
            {status.consented ? (
              <Button title="Done" variant="secondary" onPress={skip} testID="sms-signup-done" />
            ) : (
              <Button
                title={SMS_SIGNUP_STEP_SKIP}
                variant="text"
                onPress={skip}
                testID="sms-signup-skip"
              />
            )}
          </>
        ) : (
          <>
            <Text
              style={{
                color: t.color.textSecondary,
                fontSize: 14,
                lineHeight: 20,
                fontFamily: t.font.family,
              }}
            >
              Optional. You can change this any time in Account.
            </Text>
            <Button title="Set up texts" onPress={() => setOpen(true)} testID="sms-signup-start" />
            <Button
              title={SMS_SIGNUP_STEP_SKIP}
              variant="text"
              onPress={skip}
              testID="sms-signup-skip"
            />
          </>
        )}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  gap: { gap: 10 },
  card: { marginHorizontal: 16, padding: 14, gap: 12 },
  step: { marginTop: 12 },
  title: { fontWeight: '600', fontSize: 16 },
});
