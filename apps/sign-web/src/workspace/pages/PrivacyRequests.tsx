import { useEffect, useState } from 'react';
import { logout } from '@aramo/fe-foundation';

import { errorMessage, privacyApi, type PrivacyRequestView } from '../api';
import { ARAMO_SIGN_IDENTITY } from '../legal/identity';
import { DELETE_ACCOUNT_PATH, PrivacyRequestResult } from '../privacy/PrivacyRequestResult';
import { Btn, ErrorBox, Field, TextIn } from '../ui';

// Aramo-Sign-Mobile-Amendment-M-A7 §3.3 — Settings → "Delete account / privacy
// requests", for EVERY account type (the signed-in equivalent of /delete-account).
// Personal: a clear deletion request (closing alone is not deletion). Business: the
// organization decides about its documents; Aramo removes the member's own Sign data
// and access and stays responsible. Shows the request ID and status.

export function PrivacyRequestsSection({
  personal,
  loader = privacyApi.mine,
  requester = privacyApi.request,
  onDeleted = () => void logout(() => window.location.assign(DELETE_ACCOUNT_PATH)),
}: {
  personal: boolean;
  loader?: () => Promise<{ items: PrivacyRequestView[] }>;
  requester?: (t: 'DELETION') => Promise<PrivacyRequestView>;
  onDeleted?: () => void;
}) {
  const [items, setItems] = useState<PrivacyRequestView[] | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<PrivacyRequestView | null>(null);

  useEffect(() => {
    let live = true;
    loader()
      .then((r) => live && setItems(r.items))
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, []);

  const open = (items ?? []).find((r) => r.request_type === 'DELETION' && r.completed_at === null) ?? null;
  const shown = created ?? open;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await requester('DELETION');
      setCreated(r);
      setItems((prev) => [r, ...(prev ?? []).filter((x) => x.reference !== r.reference)]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sg-card" data-testid="settings-privacy-requests">
      <div className="sg-card__head">Delete account / privacy requests</div>
      <div className="sg-card__body sg-grid" style={{ gap: 12 }}>
        {personal ? (
          <div data-testid="privacy-personal-copy">
            <p style={{ margin: '0 0 8px' }}>Requesting deletion of your Aramo Sign personal account:</p>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              <li>closes the account now: sending stops and you can’t open or download your documents afterwards, so download what you want to keep first;</li>
              <li>deletes your saved signatures and initials, contacts, notifications and device registrations, and your unsent drafts with their files;</li>
              <li>signs you out everywhere and ends your sign-in, once the Aramo privacy team completes it (within 30 days);</li>
              <li>keeps only what we must: signed agreements and their evidence, legal acceptances, security logs and abuse reports, each listed with your request.</li>
            </ul>
          </div>
        ) : (
          <div data-testid="privacy-business-copy">
            <p style={{ margin: '0 0 8px' }}>Your account belongs to your organization.</p>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              <li>Your organization decides about documents it sent or that you received in your role; we refer your request to it.</li>
              <li>Aramo removes your own Aramo Sign data (saved signatures, contacts, notifications), signs you out of Aramo Sign and removes your Aramo Sign access.</li>
              <li>Aramo stays responsible for your request: if your organization doesn’t act, write to {ARAMO_SIGN_IDENTITY.privacyEmail}.</li>
            </ul>
          </div>
        )}
        {shown !== null ? (
          <>
            <PrivacyRequestResult request={shown} testId="settings-privacy-result" />
            {personal && created !== null ? (
              <div>
                <Btn onClick={onDeleted}>Sign out</Btn>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <Field label="Type DELETE to confirm" htmlFor="privacy-delete-confirm">
              <TextIn id="privacy-delete-confirm" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy} />
            </Field>
            {error !== null ? <ErrorBox>{error}</ErrorBox> : null}
            <div>
              <Btn variant="danger" disabled={busy || typed !== 'DELETE'} onClick={() => void submit()}>
                {busy ? 'Sending…' : personal ? 'Delete my account' : 'Request deletion'}
              </Btn>
            </div>
          </>
        )}
        <p className="sg-help" style={{ margin: 0 }}>
          To see, copy or correct your data, or to check a request without signing in, use <a href={DELETE_ACCOUNT_PATH}>sign.aramo.ai/delete-account</a>.
        </p>
      </div>
    </section>
  );
}
