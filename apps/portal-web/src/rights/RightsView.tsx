import { useCallback, useState } from 'react';
import { ApiError, Button, Card, InlineAlert } from '@aramo/fe-foundation';

import { portalApi } from '../portal-api';

// Portal P4 P4b (§PR-2, D-2/D-3) — the talent RTBF ("delete my account") screen.
// GRAVE by design: a plain-language statement of exactly what is and is NOT erased
// (D-2 — the platform identity goes; each organization's own record does not), a
// type-to-confirm (re-type your email), immediate execution, and a TERMINAL state
// (the session is destroyed server-side — cookies cleared, refresh tokens revoked).

export function RightsView() {
  const [confirmEmail, setConfirmEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const erase = useCallback(async () => {
    setBusy(true);
    setError(null);
    const key = crypto.randomUUID();
    try {
      await portalApi.eraseSelf(confirmEmail.trim(), key);
      setDone(true);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.status === 400
            ? 'That email does not match the address you sign in with. Please re-type it exactly.'
            : e.message
          : 'Your identity could not be deleted. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }, [confirmEmail]);

  if (done) {
    // Terminal state — the session is gone. No further action is possible; a
    // sign-in link reloads the app (which lands unauthenticated: cookies cleared).
    return (
      <div className="po-page">
        <div className="po-page__head">
          <h1 className="po-page__title">Your identity has been deleted</h1>
        </div>
        <Card title="Deleted">
          <p className="po-notice-para">
            Your Aramo sign-in and platform identity have been permanently
            deleted. Any organization that holds its own record of you keeps that
            record — contact each organization directly to exercise your rights
            with them.
          </p>
          <a className="rc-link-strong" href="/">
            Return to sign-in
          </a>
        </Card>
      </div>
    );
  }

  return (
    <div className="po-page">
      <div className="po-page__head">
        <h1 className="po-page__title">Delete my Aramo identity</h1>
      </div>
      <p className="po-page__lede">
        This permanently deletes your platform identity and sign-in. It cannot be
        undone.
      </p>
      {error !== null && <InlineAlert variant="error">{error}</InlineAlert>}

      <Card title="What is deleted">
        <p className="po-notice-para">
          Your Aramo sign-in and your cross-organization platform identity — the
          identity record Aramo holds, what has been verified about you, and any
          disputes you have raised on the platform — are permanently deleted.
        </p>
      </Card>

      <Card title="What is NOT deleted">
        <p className="po-notice-para">
          Each organization that holds its own record of you keeps that record.
          Aramo cannot delete those for you; you exercise your rights against each
          organization separately by contacting them directly.
        </p>
      </Card>

      <Card title="Confirm">
        <p className="po-notice-para">
          Type your email address to confirm. Your sign-in and platform identity
          will be permanently deleted and you will be signed out.
        </p>
        <input
          className="po-input"
          type="email"
          value={confirmEmail}
          onChange={(e) => setConfirmEmail(e.target.value)}
          placeholder="you@example.com"
          aria-label="Type your email address to confirm"
          autoComplete="off"
          disabled={busy}
        />
        <div className="po-dispute-actions">
          <Button
            variant="secondary"
            onClick={() => void erase()}
            disabled={busy || confirmEmail.trim() === ''}
          >
            Permanently delete my identity
          </Button>
        </div>
      </Card>
    </div>
  );
}
