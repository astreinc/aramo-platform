import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Card, InlineAlert, Icons } from '../ui';

import { confirmEmailVerification } from './verify-email-confirm-api';

// TR-3 B2 — the PUBLIC email-verification confirm page.
//
// Routed at the TOP level of App.tsx (BEFORE the path="/*" catch-all and
// OUTSIDE RouteGuard, mirroring /login and /invitations/accept) so it renders
// with NO session. It reads ?token= and POSTs it to the un-guarded
// /v1/email-verifications/confirm; the token in the body is the only authority.
//
// ORACLE-RESISTANT: unlike the invitation-accept page, the confirm endpoint
// returns ONE identical 404 for EVERY failure (bad / expired / consumed /
// rotated / missing / rate-limited token). There is nothing to discriminate —
// so the state union is ONLY loading | success | failure, and any thrown error
// maps to the SINGLE generic failure state. An absent token short-circuits to
// failure WITHOUT a round-trip (mirrors the invitation-accept empty-token
// short-circuit). Adding reason branches here would defeat the indistinguish-
// ability that is the point of the design.
//
// Standalone chrome: the page renders OUTSIDE the app shell. A simple Aramo
// wordmark (IconLogo + "Aramo") stands in for the shell-only ShellBrand.

type ConfirmState = 'loading' | 'success' | 'failure';

interface Props {
  // Test seam — overrides the real network call.
  confirmFn?: typeof confirmEmailVerification;
}

export function VerifyEmailConfirmPage({ confirmFn }: Props = {}) {
  const confirm = confirmFn ?? confirmEmailVerification;
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<ConfirmState>('loading');

  useEffect(() => {
    let cancelled = false;
    // An absent token never had a chance — render failure without a round-trip.
    if (token.trim().length === 0) {
      setState('failure');
      return;
    }
    setState('loading');
    confirm(token)
      .then(() => {
        if (!cancelled) setState('success');
      })
      .catch(() => {
        // ORACLE-RESISTANT: every failure — the single 404, a network drop, an
        // unexpected 5xx — collapses to ONE generic failure. No reason branch.
        if (!cancelled) setState('failure');
      });
    return () => {
      cancelled = true;
    };
  }, [confirm, token]);

  return (
    <main className="aramo-accept" data-testid="verify-email-confirm-page">
      <div className="aramo-accept__inner">
        <div className="aramo-accept__brand" aria-label="Aramo">
          <Icons.IconLogo className="aramo-accept__logo" />
          <span className="aramo-accept__wordmark">Aramo</span>
        </div>
        <Card>
          <ConfirmBody state={state} />
        </Card>
      </div>
    </main>
  );
}

function ConfirmBody({ state }: { state: ConfirmState }) {
  switch (state) {
    case 'loading':
      return (
        <p className="rc-muted-line" data-testid="verify-confirm-loading">
          Confirming your email…
        </p>
      );
    case 'success':
      return (
        <div data-testid="verify-confirm-success">
          <h1 className="aramo-accept__title">Email verified</h1>
          <p>
            Thanks — your email address is confirmed. You can close this window.
          </p>
        </div>
      );
    case 'failure':
    default:
      return (
        <div data-testid="verify-confirm-failure">
          <h1 className="aramo-accept__title">This link isn’t valid</h1>
          <InlineAlert variant="error">
            This link is invalid or has expired. Ask for a new verification
            email.
          </InlineAlert>
        </div>
      );
  }
}
