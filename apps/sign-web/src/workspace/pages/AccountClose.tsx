import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { logout } from '@aramo/fe-foundation';

import { accountApi, errorMessage, type AccountStatus } from '../api';
import { Btn, ErrorBox, Field, TextIn } from '../ui';
import { useWorkspace } from '../workspace';

// Aramo Sign Personal (Free) — "Close account" (PO decision 2026-10-22; the Personal
// Terms: "You may close your account at any time from your account settings").
// Shown only when the backend says this user may close the account (the owner of an
// open Personal account); Business accounts never see it. Typing CLOSE confirms;
// after the close the user is signed out to /account-closed.

export const ACCOUNT_CLOSED_PATH = '/account-closed';
const PRIVACY_NOTICE = '/legal/privacy';

function useAccountStatus(loader: () => Promise<AccountStatus>): AccountStatus | null {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  // Loaded once per mount (the loader is a seam for tests, not a dependency).
  useEffect(() => {
    let live = true;
    loader()
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, []);
  return status;
}

export function CloseAccountSection({
  loader = accountApi.status,
  closer = accountApi.close,
  onClosed = () => void logout(() => window.location.assign(ACCOUNT_CLOSED_PATH)),
}: {
  loader?: () => Promise<AccountStatus>;
  closer?: (reason?: string) => Promise<unknown>;
  onClosed?: () => void;
} = {}) {
  const { base } = useWorkspace();
  const status = useAccountStatus(loader);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (status === null || !status.closable) return null;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await closer(reason);
      onClosed();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <section className="sg-card" data-testid="settings-close-account">
      <div className="sg-card__head">Close account</div>
      <div className="sg-card__body sg-grid" style={{ gap: 12 }}>
        <div>
          <p style={{ margin: '0 0 8px' }}>Closing your Aramo Sign personal account:</p>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            <li>stops sending immediately. You can’t send new documents for signature from this account again.</li>
            <li>leaves requests you already sent open for their signers until they are completed, declined or expire.</li>
            <li>
              deletes your account data, documents, signed records and audit trails within 30 days, as described in the{' '}
              <a href={PRIVACY_NOTICE} target="_blank" rel="noopener noreferrer">
                Privacy Notice
              </a>
              .
            </li>
          </ul>
          <p style={{ margin: '8px 0 0' }}>
            Download anything you want to keep first: open each document from <Link to={`${base}/documents`}>Documents</Link> or your{' '}
            <Link to={`${base}/envelopes`}>envelopes</Link> and download the signed copy and its certificate.
          </p>
        </div>
        <Field label="Why are you leaving? (optional)" htmlFor="close-reason">
          <TextIn id="close-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
        </Field>
        <Field label="Type CLOSE to confirm" htmlFor="close-confirm">
          <TextIn id="close-confirm" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy} />
        </Field>
        {error !== null ? <ErrorBox>{error}</ErrorBox> : null}
        <div>
          <Btn variant="danger" disabled={busy || typed !== 'CLOSE'} onClick={() => void submit()}>
            {busy ? 'Closing…' : 'Close my account'}
          </Btn>
        </div>
      </div>
    </section>
  );
}

/** A closed Personal account opens on this notice instead of the workspace. */
export function ClosedAccountGuard({ children, loader = accountApi.status }: { children: ReactNode; loader?: () => Promise<AccountStatus> }) {
  const status = useAccountStatus(loader);
  if (status?.closed === true) return <AccountClosedNotice signedIn />;
  return <>{children}</>;
}

export function AccountClosedNotice({ signedIn = false }: { signedIn?: boolean }) {
  return (
    <div className="sg sg-center" data-testid="state-account-closed">
      <div className="sg-state">
        <div className="sg-state__mark">S</div>
        <h1 className="sg-h1">Your account is closed</h1>
        <div className="sg-lede">
          Your Aramo Sign personal account is closed and can no longer send documents. Your account data, documents, signed records and audit trails are
          deleted within 30 days, as described in the{' '}
          <a href={PRIVACY_NOTICE} target="_blank" rel="noopener noreferrer">
            Privacy Notice
          </a>
          . Signers who received a completed copy keep it.
        </div>
        <div style={{ marginTop: 16 }}>
          {signedIn ? <Btn onClick={() => void logout(() => window.location.assign(ACCOUNT_CLOSED_PATH))}>Sign out</Btn> : <a href="/login">Back to sign in</a>}
        </div>
      </div>
    </div>
  );
}

/** Public landing after closing (no session). */
export function AccountClosedPage() {
  return <AccountClosedNotice />;
}
