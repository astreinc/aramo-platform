import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '@aramo/fe-foundation';

import { Button, Card, InlineAlert, Icons } from '../ui';

import { acceptInvitation } from './invitation-accept-api';

// Invite-S3 (§5) — the PUBLIC invitation-acceptance page.
//
// Routed at the TOP level of App.tsx (BEFORE the path="/*" catch-all and
// OUTSIDE RouteGuard, mirroring /login) so it renders with NO session. It
// reads ?token= and POSTs it to the un-guarded /v1/invitations/accept; the
// token in the body is the only authority. It branches on EVERY response —
// success, each 400 reason, loading, and an unexpected/network error — into a
// clear, non-raw message. There is NO forced sign-in (the ratified separation):
// success offers a sign-in link the invitee follows when ready.
//
// Standalone chrome: the page renders OUTSIDE the app shell. A simple Aramo
// wordmark (IconLogo + "Aramo", confident-blue) stands in for the shell-only
// ShellBrand; there is no tenant logo (the internal-brand ruling).

type AcceptState =
  | { kind: 'loading' }
  | { kind: 'success' }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'already' }
  | { kind: 'revoked' }
  | { kind: 'error' };

// Map a 400 reason to a page state. Unknown reasons degrade to 'invalid'.
function stateForReason(reason: string | null): AcceptState {
  switch (reason) {
    case 'expired':
      return { kind: 'expired' };
    case 'already_accepted':
      return { kind: 'already' };
    case 'revoked':
      return { kind: 'revoked' };
    case 'missing_token':
    case 'invalid_token':
      return { kind: 'invalid' };
    default:
      return { kind: 'invalid' };
  }
}

interface Props {
  // Test seam — overrides the real network call.
  acceptFn?: typeof acceptInvitation;
}

export function InvitationAcceptPage({ acceptFn }: Props = {}) {
  const accept = acceptFn ?? acceptInvitation;
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<AcceptState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    // An absent token never had a chance — render invalid without a round-trip.
    if (token.trim().length === 0) {
      setState({ kind: 'invalid' });
      return;
    }
    setState({ kind: 'loading' });
    accept(token)
      .then(() => {
        if (!cancelled) setState({ kind: 'success' });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 400) {
          const reason =
            typeof err.details?.['reason'] === 'string'
              ? (err.details['reason'] as string)
              : null;
          setState(stateForReason(reason));
          return;
        }
        // Network / unexpected 5xx — graceful generic.
        setState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [accept, token]);

  return (
    <main className="aramo-accept" data-testid="invitation-accept-page">
      <div className="aramo-accept__inner">
        <div className="aramo-accept__brand" aria-label="Aramo">
          <Icons.IconLogo className="aramo-accept__logo" />
          <span className="aramo-accept__wordmark">Aramo</span>
        </div>
        <Card>
          <AcceptBody state={state} />
        </Card>
      </div>
    </main>
  );
}

function AcceptBody({ state }: { state: AcceptState }) {
  switch (state.kind) {
    case 'loading':
      return (
        <p className="rc-muted-line" data-testid="accept-loading">
          Validating your invitation…
        </p>
      );
    case 'success':
      return (
        <div data-testid="accept-success">
          <h1 className="aramo-accept__title">You’re confirmed</h1>
          <p>
            Your invitation is accepted. Sign in with your work account whenever
            you’re ready.
          </p>
          <SignInLink />
        </div>
      );
    case 'already':
      return (
        <div data-testid="accept-already">
          <h1 className="aramo-accept__title">Already accepted</h1>
          <p>You’ve already accepted this invitation. Sign in here.</p>
          <SignInLink />
        </div>
      );
    case 'expired':
      return (
        <div data-testid="accept-expired">
          <h1 className="aramo-accept__title">This invitation has expired</h1>
          <InlineAlert variant="error">
            Ask your admin to resend the invitation.
          </InlineAlert>
        </div>
      );
    case 'revoked':
      return (
        <div data-testid="accept-revoked">
          <h1 className="aramo-accept__title">Invitation cancelled</h1>
          <InlineAlert variant="error">
            This invitation has been cancelled. Contact your admin.
          </InlineAlert>
        </div>
      );
    case 'invalid':
      return (
        <div data-testid="accept-invalid">
          <h1 className="aramo-accept__title">This link isn’t valid</h1>
          <InlineAlert variant="error">
            This invitation link is invalid. Ask your admin to resend it.
          </InlineAlert>
        </div>
      );
    case 'error':
    default:
      return (
        <div data-testid="accept-error">
          <h1 className="aramo-accept__title">Something went wrong</h1>
          <InlineAlert variant="error">
            We couldn’t process your invitation just now. Please try again in a
            moment.
          </InlineAlert>
        </div>
      );
  }
}

function SignInLink() {
  return (
    <div className="aramo-accept__cta">
      <Link to="/login">
        <Button data-testid="accept-signin">Sign in to Aramo</Button>
      </Link>
    </div>
  );
}
