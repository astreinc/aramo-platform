import { useEffect, useState, type FormEvent } from 'react';
import { Input } from '@aramo/fe-foundation';
import { STEP_UP_CODE_LENGTH, normalizeStepUpCode } from '@aramo/sign-client';

import {
  E164_RE,
  errorMessage,
  smsConsentApi,
  type SmsConsentChannel,
  type SmsConsentStatus,
} from '../api';
import { clearSmsSignupOffer, smsSignupOfferPending } from '../sms-signup-offer';
import {
  SMS_CONSENT_WORDING,
  SMS_CONSENT_WORDING_VERSION,
  SMS_SIGNUP_STEP_SKIP,
  SMS_SIGNUP_STEP_TITLE,
} from '../sms-consent-copy';
import { Btn, ErrorBox, Field, LinkBtn, TextIn, fmtDate } from '../ui';

// SMS-CONSENT-1 §2 (R-3) — Settings → Text messages: the signed-in person's own number and
// consent. Verify a mobile number with a texted code, then a SEPARATE box with the consent
// wording, never ticked for them; Turn off and Remove number. Per person, not per
// organization. Shown only while the server says texts are available (R-8: off today).
// The same flow opens from the optional step after signup (channel SIGNUP).

/** The number, code and consent steps (shared by Settings and the signup step). */
export function SmsConsentFlow({
  status,
  channel,
  onChange,
}: {
  status: SmsConsentStatus;
  channel: SmsConsentChannel;
  onChange: (s: SmsConsentStatus) => void;
}) {
  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [agree, setAgree] = useState(false);
  const [sentTo, setSentTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const wording =
    status.wording !== null && status.wording.trim() !== '' ? status.wording : SMS_CONSENT_WORDING;
  const version = status.wording_version ?? SMS_CONSENT_WORDING_VERSION;
  const phoneBad = phone.trim() !== '' && !E164_RE.test(phone.trim());

  const run = async (work: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError('');
    try {
      await work();
      after?.();
      onChange(await smsConsentApi.get());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const sendCode = async (e?: FormEvent) => {
    e?.preventDefault();
    if (phoneBad || phone.trim() === '') return;
    setBusy(true);
    setError('');
    try {
      const r = await smsConsentApi.sendCode(phone);
      setSentTo(r.phone_masked ?? phone.trim());
      setCode('');
      setStage('code');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const verify = (e?: FormEvent) => {
    e?.preventDefault();
    void run(
      () => smsConsentApi.verify(code),
      () => {
        setStage('phone');
        setPhone('');
        setCode('');
        setAgree(false);
      },
    );
  };

  const remove = () =>
    void run(
      () => smsConsentApi.remove(),
      () => setAgree(false),
    );

  if (!status.phone_verified) {
    return (
      <div className="sg-grid" style={{ gap: 10 }} data-testid="sms-consent-flow">
        {stage === 'phone' ? (
          <form
            className="sg-grid"
            style={{ gap: 10 }}
            onSubmit={(e) => void sendCode(e)}
            noValidate
          >
            <Field
              label="Mobile number"
              htmlFor="sms-consent-phone"
              help="International format, for example +14155550123."
              error={
                phoneBad ? 'Enter the number with + and the country code, no spaces.' : undefined
              }
            >
              <TextIn
                id="sms-consent-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                placeholder="+14155550123"
                onChange={(e) => setPhone(e.target.value)}
                data-testid="sms-consent-phone"
              />
            </Field>
            <Btn
              variant="primary"
              type="submit"
              style={{ alignSelf: 'flex-start' }}
              disabled={busy || phone.trim() === '' || phoneBad}
              data-testid="sms-consent-send-code"
            >
              {busy ? 'Sending…' : 'Text me a code'}
            </Btn>
          </form>
        ) : (
          <form className="sg-grid" style={{ gap: 10 }} onSubmit={verify} noValidate>
            <p className="sg-help" role="status" style={{ margin: 0 }}>
              We texted a code to {sentTo}.
            </p>
            <Field label="Code" htmlFor="sms-consent-code">
              <TextIn
                id="sms-consent-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={STEP_UP_CODE_LENGTH}
                value={code}
                onChange={(e) => setCode(normalizeStepUpCode(e.target.value))}
                data-testid="sms-consent-code"
              />
            </Field>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <Btn
                variant="primary"
                type="submit"
                disabled={busy || code.length !== STEP_UP_CODE_LENGTH}
                data-testid="sms-consent-verify"
              >
                {busy ? 'Checking…' : 'Verify'}
              </Btn>
              <LinkBtn
                type="button"
                disabled={busy}
                onClick={() => setStage('phone')}
                data-testid="sms-consent-change-number"
              >
                Use another number
              </LinkBtn>
            </div>
          </form>
        )}
        {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
      </div>
    );
  }

  return (
    <div className="sg-grid" style={{ gap: 10 }} data-testid="sms-consent-flow">
      <p className="sg-help" style={{ margin: 0 }} data-testid="sms-consent-number">
        Your number: {status.phone_masked ?? '—'} (verified)
      </p>
      {status.consented ? (
        <>
          <p className="sg-help" role="status" style={{ margin: 0 }} data-testid="sms-consent-on">
            Texts are on
            {status.consented_at !== null ? ` since ${fmtDate(status.consented_at)}` : ''}.
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <Btn
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  smsConsentApi.put({ consented: false, wording_version: version, channel }),
                )
              }
              data-testid="sms-consent-turn-off"
            >
              Turn off
            </Btn>
            <Btn
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={remove}
              data-testid="sms-consent-remove"
            >
              Remove number
            </Btn>
          </div>
        </>
      ) : (
        <>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 14 }}>
            <Input
              unstyled
              type="checkbox"
              checked={agree}
              onChange={(e) => setAgree(e.target.checked)}
              data-testid="sms-consent-agree"
            />
            <span data-testid="sms-consent-wording">{wording}</span>
          </label>
          <div style={{ display: 'flex', gap: 10 }}>
            <Btn
              variant="primary"
              size="sm"
              disabled={busy || !agree}
              onClick={() =>
                void run(() =>
                  smsConsentApi.put({ consented: true, wording_version: version, channel }),
                )
              }
              data-testid="sms-consent-save"
            >
              Turn on texts
            </Btn>
            <Btn
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={remove}
              data-testid="sms-consent-remove"
            >
              Remove number
            </Btn>
          </div>
        </>
      )}
      {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
    </div>
  );
}

function useSmsConsent(): [SmsConsentStatus | null, (s: SmsConsentStatus) => void] {
  const [status, setStatus] = useState<SmsConsentStatus | null>(null);
  useEffect(() => {
    let live = true;
    smsConsentApi.get().then(
      (s) => {
        if (live) setStatus(s);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return [status, setStatus];
}

/** Settings → Text messages (web channel). Renders nothing unless texts are available. */
export function TextMessagesSection() {
  const [status, setStatus] = useSmsConsent();
  if (status?.available !== true) return null;
  return (
    <section className="sg-card" data-testid="settings-text-messages">
      <div className="sg-card__head">
        Text messages <span className="sg-tag sg-tag--blue">Sign only</span>
      </div>
      <div className="sg-card__body sg-grid" style={{ gap: 10 }}>
        <p className="sg-help" style={{ marginTop: 0 }}>
          Get signing requests, reminders and signing codes by text from people who send you
          documents.
        </p>
        <SmsConsentFlow status={status} channel="WEB" onChange={setStatus} />
      </div>
    </section>
  );
}

/**
 * The optional step after signup (R-3): shown once, after the first sign-in that follows a
 * signup on this browser, while texts are available and the person has not turned them on.
 * "Not now" skips it for good.
 */
export function SmsSignupStep() {
  const [pending, setPending] = useState(smsSignupOfferPending);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SmsConsentStatus | null>(null);
  // Offered once: when it is not shown (texts unavailable, or already on) it is not kept for later.
  const [offered] = useState(pending);
  useEffect(() => {
    if (!offered) return undefined;
    let live = true;
    smsConsentApi.get().then(
      (s) => {
        if (!live) return;
        if (s.available !== true || s.consented) {
          clearSmsSignupOffer();
          setPending(false);
        } else setStatus(s);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [offered]);
  if (!pending || status === null) return null;
  const skip = () => {
    clearSmsSignupOffer();
    setPending(false);
  };
  return (
    <section className="sg-card" data-testid="sms-signup-step" style={{ marginTop: 14 }}>
      <div className="sg-card__head">{SMS_SIGNUP_STEP_TITLE}</div>
      <div className="sg-card__body sg-grid" style={{ gap: 10 }}>
        {open ? (
          <>
            <SmsConsentFlow status={status} channel="SIGNUP" onChange={setStatus} />
            {status.consented ? (
              <Btn
                size="sm"
                style={{ alignSelf: 'flex-start' }}
                onClick={skip}
                data-testid="sms-signup-done"
              >
                Done
              </Btn>
            ) : null}
          </>
        ) : (
          <>
            <p className="sg-help" style={{ margin: 0 }}>
              Optional. You can change this any time in Settings.
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <Btn
                variant="primary"
                size="sm"
                onClick={() => setOpen(true)}
                data-testid="sms-signup-start"
              >
                Set up texts
              </Btn>
              <Btn size="sm" variant="ghost" onClick={skip} data-testid="sms-signup-skip">
                {SMS_SIGNUP_STEP_SKIP}
              </Btn>
            </div>
          </>
        )}
        {open && !status.consented ? (
          <LinkBtn type="button" onClick={skip} data-testid="sms-signup-skip">
            {SMS_SIGNUP_STEP_SKIP}
          </LinkBtn>
        ) : null}
      </div>
    </section>
  );
}
