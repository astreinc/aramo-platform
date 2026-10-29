import { useEffect, useState } from 'react';
import { Button, logout } from '@aramo/fe-foundation';

import { errorMessage, privacyApi, type PrivacyRequestType, type PrivacyRequestView } from '../api';
import { ARAMO_SIGN_IDENTITY } from '../legal/identity';
import { DELETE_ACCOUNT_PATH, PrivacyRequestResult } from '../privacy/PrivacyRequestResult';
import { Btn, ErrorBox, Field, TextIn } from '../ui';

// Aramo-Sign-Mobile-Amendment-M-A7 §3.3 — Settings → privacy requests (the signed-in
// equivalent of /delete-account), shows the request ID and status.
// Aramo-Sign-Mobile-Amendment-M-A8 §2 — only the Personal account owner (the
// tenant_owner of a PERSONAL tenant) gets "Delete my account". A Business user's
// account is managed by their organization: no self-service delete; a "Privacy
// requests" card instead (ACCESS, EXPORT, CORRECTION, DELETION of eligible personal
// information). A Business DELETION is referred to the organization and the Aramo
// privacy team and is never executed by self-service.

export const BUSINESS_MANAGED_COPY =
  'Your organization manages this account. Contact your organization administrator to manage product access.';

export const BUSINESS_PRIVACY_TYPES: readonly { key: PrivacyRequestType; label: string; sub: string }[] = [
  { key: 'ACCESS', label: 'See my personal information', sub: 'Ask which personal information Aramo Sign holds about you.' },
  { key: 'EXPORT', label: 'Get a copy of my personal information', sub: 'Receive a copy of your Aramo Sign data.' },
  { key: 'CORRECTION', label: 'Correct my personal information', sub: 'Ask us to correct information that is wrong.' },
  {
    key: 'DELETION',
    label: 'Delete my eligible personal information',
    sub: 'Referred to your organization (it decides about documents it sent or that you received in your role) and reviewed by the Aramo privacy team. Your account stays with your organization.',
  },
];

export function PrivacyRequestsSection({
  personal,
  loader = privacyApi.mine,
  requester = privacyApi.request,
  onDeleted = () => void logout(() => window.location.assign(DELETE_ACCOUNT_PATH)),
}: {
  personal: boolean;
  loader?: () => Promise<{ items: PrivacyRequestView[] }>;
  requester?: (t: PrivacyRequestType) => Promise<PrivacyRequestView>;
  onDeleted?: () => void;
}) {
  if (!personal) return <BusinessPrivacyRequests loader={loader} requester={requester} />;
  return <PersonalDeleteAccount loader={loader} requester={requester} onDeleted={onDeleted} />;
}

function PersonalDeleteAccount({
  loader,
  requester,
  onDeleted,
}: {
  loader: () => Promise<{ items: PrivacyRequestView[] }>;
  requester: (t: PrivacyRequestType) => Promise<PrivacyRequestView>;
  onDeleted: () => void;
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
        <div data-testid="privacy-personal-copy">
          <p style={{ margin: '0 0 8px' }}>Requesting deletion of your Aramo Sign personal account:</p>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            <li>closes the account now: sending stops and you can’t open or download your documents afterwards, so download what you want to keep first;</li>
            <li>deletes your saved signatures and initials, contacts, notifications and device registrations, and your unsent drafts with their files;</li>
            <li>signs you out everywhere and ends your sign-in, once the Aramo privacy team completes it (within 30 days);</li>
            <li>keeps only what we must: signed agreements and their evidence, legal acceptances, security logs and abuse reports, each listed with your request.</li>
          </ul>
        </div>
        {shown !== null ? (
          <>
            <PrivacyRequestResult request={shown} testId="settings-privacy-result" />
            {created !== null ? (
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
                {busy ? 'Sending…' : 'Delete my account'}
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

/** M-A8 §2.1/§2.2 — a Business user: organization-managed; privacy requests only. */
function BusinessPrivacyRequests({
  loader,
  requester,
}: {
  loader: () => Promise<{ items: PrivacyRequestView[] }>;
  requester: (t: PrivacyRequestType) => Promise<PrivacyRequestView>;
}) {
  const [items, setItems] = useState<PrivacyRequestView[] | null>(null);
  const [type, setType] = useState<PrivacyRequestType>('ACCESS');
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

  const openRequests = (items ?? []).filter((r) => r.completed_at === null);
  const needsConfirm = type === 'DELETION';

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await requester(type);
      setCreated(r);
      setTyped('');
      setItems((prev) => [r, ...(prev ?? []).filter((x) => x.reference !== r.reference)]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sg-card" data-testid="settings-privacy-requests">
      <div className="sg-card__head">Privacy requests</div>
      <div className="sg-card__body sg-grid" style={{ gap: 12 }}>
        <p style={{ margin: 0 }} data-testid="privacy-business-managed">
          {BUSINESS_MANAGED_COPY}
        </p>
        <p className="sg-help" style={{ margin: 0 }}>
          You can still ask the Aramo privacy team to see, copy, correct or delete your eligible personal information. Aramo stays responsible for
          your request: if your organization doesn’t act, write to {ARAMO_SIGN_IDENTITY.privacyEmail}.
        </p>
        {created !== null ? <PrivacyRequestResult request={created} testId="settings-privacy-result" /> : null}
        <div role="radiogroup" aria-label="Privacy request" className="sg-grid" style={{ gap: 6 }}>
          {BUSINESS_PRIVACY_TYPES.map((t) => (
            <Button
              key={t.key}
              unstyled
              role="radio"
              aria-checked={type === t.key}
              className="sg-settings-row"
              style={{ alignItems: 'flex-start', textAlign: 'left', background: 'none', border: 0, padding: '4px 0', cursor: 'pointer' }}
              onClick={() => {
                setType(t.key);
                setError(null);
              }}
              data-testid={`settings-privacy-type-${t.key}`}
            >
              <span aria-hidden="true">{type === t.key ? '◉' : '○'}</span>
              <span>
                <strong>{t.label}</strong>
                <span className="sg-help" style={{ display: 'block', margin: 0 }}>
                  {t.sub}
                </span>
              </span>
            </Button>
          ))}
        </div>
        {needsConfirm ? (
          <Field label="Type DELETE to confirm" htmlFor="privacy-delete-confirm">
            <TextIn id="privacy-delete-confirm" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy} />
          </Field>
        ) : null}
        {error !== null ? <ErrorBox>{error}</ErrorBox> : null}
        <div>
          <Btn disabled={busy || (needsConfirm && typed !== 'DELETE')} onClick={() => void submit()} data-testid="settings-privacy-send">
            {busy ? 'Sending…' : 'Send privacy request'}
          </Btn>
        </div>
        {openRequests.length > 0 && created === null ? (
          <div className="sg-help" style={{ margin: 0 }} data-testid="settings-privacy-open">
            Open requests: {openRequests.map((r) => `${r.reference} (${r.status_label})`).join(' · ')}
          </div>
        ) : null}
        <p className="sg-help" style={{ margin: 0 }}>
          To check a request without signing in, use <a href={DELETE_ACCOUNT_PATH}>sign.aramo.ai/delete-account</a>.
        </p>
      </div>
    </section>
  );
}
