import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError, Input } from '@aramo/fe-foundation';

import { Button, Card, InlineAlert, Icons } from '../ui';

import { VERIFICATION_CODE_LENGTH, confirmEmailVerification } from './verify-email-confirm-api';

// TR-3 B2 → ATI-SEP-1 T10 WP3b (Addendum A3 T10-3) — the PUBLIC email
// verification page: the talent enters the 6-digit code Talent Intelligence
// mailed them.
//
// Routed at the TOP level of App.tsx (BEFORE the path="/*" catch-all and OUTSIDE
// RouteGuard, mirroring /login and /invitations/accept) so it renders with NO
// session. The verification id comes from the emailed link
// (?verification_id=…; ?id= is accepted too); the code is typed here and POSTed
// to the un-guarded /v1/email-verifications/confirm.
//
// States: entry (code form) → submitting → verified | a refusal message. A wrong
// code keeps the form (with the attempts left); expired / locked / already
// verified / unknown link end the flow with a plain message. A missing id never
// makes a round-trip.
//
// Standalone chrome: the page renders OUTSIDE the app shell (IconLogo + "Aramo").

type Outcome =
  | { kind: 'entry'; error: string | null }
  | { kind: 'submitting' }
  | { kind: 'verified' }
  | { kind: 'ended'; title: string; message: string };

interface Props {
  // Test seam — overrides the real network call.
  confirmFn?: typeof confirmEmailVerification;
}

const CODE_RE = new RegExp(`^\\d{${VERIFICATION_CODE_LENGTH}}$`);

function refusal(err: unknown): Outcome {
  if (err instanceof ApiError) {
    const reason = typeof err.details?.['reason'] === 'string' ? (err.details['reason'] as string) : null;
    if (err.status === 422 && reason === 'INVALID_CODE') {
      const left = err.details?.['attempts_remaining'];
      return {
        kind: 'entry',
        error:
          typeof left === 'number'
            ? `That code isn’t right. ${left === 1 ? 'One attempt' : `${left} attempts`} left.`
            : 'That code isn’t right. Check the email and try again.',
      };
    }
    if (err.status === 422 && reason === 'ALREADY_CONFIRMED') {
      return { kind: 'verified' };
    }
    if (err.status === 422 && reason === 'VERIFICATION_EXPIRED') {
      return { kind: 'ended', title: 'This code has expired', message: 'Ask for a new verification email.' };
    }
    if (err.status === 422 && reason === 'VERIFICATION_LOCKED') {
      return { kind: 'ended', title: 'Too many attempts', message: 'This code is locked. Ask for a new verification email.' };
    }
    if (err.status === 400) {
      return { kind: 'entry', error: `Enter the ${VERIFICATION_CODE_LENGTH}-digit code from the email.` };
    }
    if (err.status === 503) {
      return { kind: 'entry', error: 'Verification is temporarily unavailable. Please try again shortly.' };
    }
  }
  return { kind: 'ended', title: 'This link isn’t valid', message: 'This link is invalid or has expired. Ask for a new verification email.' };
}

export function VerifyEmailConfirmPage({ confirmFn }: Props = {}) {
  const confirm = confirmFn ?? confirmEmailVerification;
  const [params] = useSearchParams();
  const verificationId = (params.get('verification_id') ?? params.get('id') ?? '').trim();
  const [code, setCode] = useState('');
  const [outcome, setOutcome] = useState<Outcome>(
    verificationId.length === 0
      ? { kind: 'ended', title: 'This link isn’t valid', message: 'This link is invalid or has expired. Ask for a new verification email.' }
      : { kind: 'entry', error: null },
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim();
    if (!CODE_RE.test(c)) {
      setOutcome({ kind: 'entry', error: `Enter the ${VERIFICATION_CODE_LENGTH}-digit code from the email.` });
      return;
    }
    setOutcome({ kind: 'submitting' });
    try {
      await confirm(verificationId, c);
      setOutcome({ kind: 'verified' });
    } catch (err) {
      setOutcome(refusal(err));
    }
  };

  return (
    <main className="aramo-accept" data-testid="verify-email-confirm-page">
      <div className="aramo-accept__inner">
        <div className="aramo-accept__brand" aria-label="Aramo">
          <Icons.IconLogo className="aramo-accept__logo" />
          <span className="aramo-accept__wordmark">Aramo</span>
        </div>
        <Card>
          {outcome.kind === 'verified' ? (
            <div data-testid="verify-confirm-success">
              <h1 className="aramo-accept__title">Email verified</h1>
              <p>Thanks — your email address is confirmed. You can close this window.</p>
            </div>
          ) : outcome.kind === 'ended' ? (
            <div data-testid="verify-confirm-failure">
              <h1 className="aramo-accept__title">{outcome.title}</h1>
              <InlineAlert variant="error">{outcome.message}</InlineAlert>
            </div>
          ) : (
            <form onSubmit={(e) => void submit(e)} data-testid="verify-confirm-form">
              <h1 className="aramo-accept__title">Verify your email</h1>
              <p>Enter the {VERIFICATION_CODE_LENGTH}-digit code from the verification email.</p>
              <label className="rc-field">
                <span className="rc-field__label">Verification code</span>
                <Input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={VERIFICATION_CODE_LENGTH}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  aria-label="Verification code"
                  disabled={outcome.kind === 'submitting'}
                />
              </label>
              {outcome.kind === 'entry' && outcome.error !== null ? (
                <InlineAlert variant="error">{outcome.error}</InlineAlert>
              ) : null}
              <Button type="submit" disabled={outcome.kind === 'submitting' || code.length !== VERIFICATION_CODE_LENGTH}>
                {outcome.kind === 'submitting' ? 'Verifying…' : 'Verify'}
              </Button>
            </form>
          )}
        </Card>
      </div>
    </main>
  );
}
