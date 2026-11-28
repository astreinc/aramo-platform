import { useEffect, useState, type FormEvent } from 'react';
import { PHONE_STEP_UP_COPY as C, STEP_UP_CODE_LENGTH, isStepUpCode, normalizeStepUpCode, type PhoneStepUpStatus } from '@aramo/sign-client';

import { errorMessage, stepUpApi } from '../api';
import { Btn, ErrorBox, Field, LinkBtn, TextIn } from '../ui';

// SIGN-FREE-PARITY-1 S2 — the send refusal `phone_verification_required`, self-serve: a
// young Personal account verifies its phone with a texted code, then sends. Shown by the
// Review & send step only when the server says self-serve is on (status.available); when
// it is off the step keeps today's plain message. Copy and the code rule: @aramo/sign-client.

type Stage = { k: 'start'; entering: boolean } | { k: 'code'; masked: string; resendAt: number } | { k: 'done' };

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function PhoneStepUpPanel({ status, onVerified, onClose }: { status: PhoneStepUpStatus; onVerified: () => void; onClose: () => void }) {
  const [stage, setStage] = useState<Stage>({ k: 'start', entering: status.phone_masked === null });
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const now = useNow(stage.k === 'code');

  const sendCode = async (e?: FormEvent) => {
    e?.preventDefault();
    setError('');
    setBusy(true);
    try {
      const entered = stage.k === 'start' && stage.entering ? phone : undefined;
      const r = await stepUpApi.send(entered);
      setCode('');
      setStage({ k: 'code', masked: r.phone_masked, resendAt: Date.now() + r.resend_after_seconds * 1000 });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!isStepUpCode(code)) {
      setError(C.codeIncomplete);
      return;
    }
    setError('');
    setBusy(true);
    try {
      await stepUpApi.verify(code);
      setStage({ k: 'done' });
    } catch (err) {
      setError(errorMessage(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sg-card" data-testid="phone-step-up" aria-labelledby="phone-step-up-title" style={{ marginTop: 12 }}>
      <div className="sg-card__body sg-grid" style={{ gap: 10 }}>
        <div id="phone-step-up-title" style={{ fontWeight: 600 }}>
          {C.title}
        </div>
        {stage.k === 'start' ? (
          <form className="sg-grid" style={{ gap: 10 }} onSubmit={(e) => void sendCode(e)} noValidate>
            <p className="sg-help">{C.intro}</p>
            {stage.entering ? (
              <Field label={C.phoneLabel} htmlFor="step-up-phone" help={C.phoneHint}>
                <TextIn id="step-up-phone" type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="step-up-phone" />
              </Field>
            ) : (
              <p className="sg-help">
                {C.sendTo(status.phone_masked ?? '')}{' '}
                <LinkBtn type="button" onClick={() => setStage({ k: 'start', entering: true })} data-testid="step-up-other-number">
                  {C.useAnotherNumber}
                </LinkBtn>
              </p>
            )}
            <Btn variant="primary" type="submit" disabled={busy || (stage.entering && phone.trim() === '')} data-testid="step-up-send">
              {busy ? C.sending : C.sendCode}
            </Btn>
            <p className="sg-help" style={{ margin: 0 }} data-testid="step-up-disclosure">
              {C.smsDisclosure}
            </p>
          </form>
        ) : null}
        {stage.k === 'code' ? (
          <form className="sg-grid" style={{ gap: 10 }} onSubmit={(e) => void verify(e)} noValidate>
            <p className="sg-help" role="status">
              {C.sentTo(stage.masked)}
            </p>
            <Field label={C.codeLabel} htmlFor="step-up-code">
              <TextIn
                id="step-up-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={STEP_UP_CODE_LENGTH}
                value={code}
                onChange={(e) => setCode(normalizeStepUpCode(e.target.value))}
                data-testid="step-up-code"
              />
            </Field>
            <Btn variant="primary" type="submit" disabled={busy || code.length !== STEP_UP_CODE_LENGTH} data-testid="step-up-verify">
              {busy ? C.verifying : C.verify}
            </Btn>
            {now < stage.resendAt ? (
              <p className="sg-help">{C.resendIn(Math.ceil((stage.resendAt - now) / 1000))}</p>
            ) : (
              <LinkBtn type="button" disabled={busy} onClick={() => void sendCode()} data-testid="step-up-resend">
                {C.resend}
              </LinkBtn>
            )}
          </form>
        ) : null}
        {stage.k === 'done' ? (
          <>
            <p className="sg-help" role="status" data-testid="step-up-verified">
              {C.verified}
            </p>
            <Btn variant="primary" onClick={onVerified} data-testid="step-up-send-now">
              {C.sendNow}
            </Btn>
          </>
        ) : null}
        {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
        {stage.k !== 'done' ? (
          <Btn size="sm" variant="ghost" onClick={onClose} data-testid="step-up-cancel">
            {C.cancel}
          </Btn>
        ) : null}
      </div>
    </section>
  );
}
