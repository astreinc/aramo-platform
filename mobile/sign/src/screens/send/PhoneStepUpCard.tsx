// SIGN-FREE-PARITY-1 S2 — Review and send: a send refused with `phone_verification_required`
// offers to verify the phone with a texted code when the server says self-serve is on
// (status.available). Off (the default), this renders nothing and Review keeps today's plain
// message. The web shows the same panel (apps/sign-web PhoneStepUp.tsx); copy and the code
// rule are @aramo/sign-client.
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PHONE_STEP_UP_COPY as C, STEP_UP_CODE_LENGTH, isStepUpCode, normalizeStepUpCode, offersPhoneStepUp } from '@aramo/sign-client';

import { isApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import type { WorkspaceClient } from '../../api/workspaceClient';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { loadStepUpStatus, sendStepUpCode, verifyStepUpCode, type StepUpStatus } from '../../features/send/phoneStepUp';
import { ErrorText, TextField } from '../../features/send/ui';
import { useTheme } from '../../theme';

type Stage = { k: 'start'; entering: boolean } | { k: 'code'; masked: string; resendAt: number } | { k: 'done' };

const messageOf = (e: unknown): string => (isApiError(e) ? refusalMessage(e) : refusalMessage({ reason: '', code: '' }));

export function PhoneStepUpCard({
  workspace,
  onVerified,
  now = () => Date.now(),
}: {
  readonly workspace: WorkspaceClient;
  readonly onVerified: () => void;
  readonly now?: () => number;
}) {
  const t = useTheme();
  const [status, setStatus] = useState<StepUpStatus | null>(null);
  const [stage, setStage] = useState<Stage>({ k: 'start', entering: false });
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    let live = true;
    loadStepUpStatus(workspace)
      .then((s) => {
        if (!live) return;
        setStatus(s);
        setStage({ k: 'start', entering: s.phone_masked === null });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workspace]);

  useEffect(() => {
    if (stage.k !== 'code') return undefined;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [stage.k]);

  if (!offersPhoneStepUp('phone_verification_required', status)) return null;

  const sendCode = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await sendStepUpCode(workspace, stage.k === 'start' && stage.entering ? phone : undefined);
      setCode('');
      setStage({ k: 'code', masked: r.phone_masked, resendAt: now() + r.resend_after_seconds * 1000 });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!isStepUpCode(code)) {
      setError(C.codeIncomplete);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await verifyStepUpCode(workspace, code);
      setStage({ k: 'done' });
    } catch (e) {
      setError(messageOf(e));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const body = { color: t.color.textSecondary, fontSize: 14, lineHeight: 20, fontFamily: t.font.family };
  const left = stage.k === 'code' ? Math.ceil((stage.resendAt - now()) / 1000) : 0;

  return (
    <Card>
      <View style={styles.body} testID="phone-step-up">
        <Text accessibilityRole="header" style={[styles.title, { color: t.color.text, fontFamily: t.font.family }]}>
          {C.title}
        </Text>
        {stage.k === 'start' ? (
          <>
            <Text style={body}>{C.intro}</Text>
            {stage.entering ? (
              <TextField
                label={C.phoneLabel}
                hint={C.phoneHint}
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                autoComplete="tel"
                textContentType="telephoneNumber"
                testID="step-up-phone"
              />
            ) : (
              <>
                <Text style={body}>{C.sendTo(status?.phone_masked ?? '')}</Text>
                <Button title={C.useAnotherNumber} variant="text" onPress={() => setStage({ k: 'start', entering: true })} testID="step-up-other-number" />
              </>
            )}
            <Button
              title={C.sendCode}
              onPress={() => void sendCode()}
              busy={busy}
              disabled={busy || (stage.entering && phone.trim() === '')}
              testID="step-up-send"
            />
            <Text style={body} testID="step-up-disclosure">
              {C.smsDisclosure}
            </Text>
          </>
        ) : null}
        {stage.k === 'code' ? (
          <>
            <Text style={body} accessibilityLiveRegion="polite">
              {C.sentTo(stage.masked)}
            </Text>
            <TextField
              label={C.codeLabel}
              value={code}
              onChangeText={(v) => setCode(normalizeStepUpCode(v))}
              keyboardType="number-pad"
              autoComplete="sms-otp"
              textContentType="oneTimeCode"
              maxLength={STEP_UP_CODE_LENGTH}
              testID="step-up-code"
            />
            <Button title={C.verify} onPress={() => void verify()} busy={busy} disabled={busy || code.length !== STEP_UP_CODE_LENGTH} testID="step-up-verify" />
            {left > 0 ? (
              <Text style={body}>{C.resendIn(left)}</Text>
            ) : (
              <Button title={C.resend} variant="text" onPress={() => void sendCode()} disabled={busy} testID="step-up-resend" />
            )}
          </>
        ) : null}
        {stage.k === 'done' ? (
          <>
            <Text style={body} accessibilityLiveRegion="polite" testID="step-up-verified">
              {C.verified}
            </Text>
            <Button title={C.sendNow} onPress={onVerified} testID="step-up-send-now" />
          </>
        ) : null}
        <ErrorText>{error}</ErrorText>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 10 },
  title: { fontWeight: '600', fontSize: 16 },
});
