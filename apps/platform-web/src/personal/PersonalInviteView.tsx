import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, Button, FormField, InlineAlert, Input } from '@aramo/fe-foundation';

import { platformApi, type PersonalInvite } from '../platform-api';

// Aramo Sign Personal (Free) §10 — pilot (`invite` mode) invite codes: one-time,
// bound to one email, expiring after 7 days, capped by SIGN_PERSONAL_PILOT_CAP.
// The code is shown ONCE (the backend stores only its hash); the operator copies
// it and gives it to the invited person.

export function PersonalInviteView() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<PersonalInvite | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const inv = await platformApi.issuePersonalInvite({ email: email.trim() });
      setIssued(inv);
      setCopied(false);
      setEmail('');
    } catch (err) {
      const reason = err instanceof ApiError ? err.details?.['reason'] : undefined;
      setError(err instanceof ApiError ? `${err.message}${typeof reason === 'string' ? ` (${reason})` : ''}` : 'Could not issue the invite.');
    } finally {
      setBusy(false);
    }
  };

  const copy = (): void => {
    if (issued === null) return;
    void navigator.clipboard
      ?.writeText(issued.code)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <div className="pw-page" style={{ maxWidth: 620 }} data-testid="personal-invites">
      <div className="pw-page__head">
        <h1 className="pw-page__title">Issue pilot invite</h1>
        <Link to="/personal-review">Personal review queue</Link>
      </div>
      <p className="pw-audit__detail" style={{ marginTop: 0 }}>
        For the Aramo Sign Personal pilot. The code works once, only for this email address, and expires after 7 days.
      </p>
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      {issued !== null ? (
        <div className="pw-notice" role="status" data-testid="personal-invite-issued">
          <div>
            Invite code for <strong>{issued.email}</strong>
            {issued.expires_at !== null ? ` (expires ${new Date(issued.expires_at).toLocaleString()})` : ''}:
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
            <code className="mono" style={{ fontSize: '1.1rem', userSelect: 'all' }} data-testid="personal-invite-code">
              {issued.code}
            </code>
            <Button variant="secondary" size="sm" onClick={copy} data-testid="personal-invite-copy">
              {copied ? 'Copied' : 'Copy code'}
            </Button>
          </div>
          <div className="pw-audit__meta" style={{ marginTop: 8 }}>
            This code is shown only once. Copy it now.
          </div>
        </div>
      ) : null}
      <form className="pw-field-row" onSubmit={(e) => void submit(e)}>
        <FormField label="Email address" helper="The personal email the invited person will sign up with.">
          <Input unstyled className="tc-input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@gmail.com" />
        </FormField>
        <div className="pw-actions">
          <Button variant="primary" type="submit" disabled={busy || email.trim() === ''} data-testid="personal-invite-submit">
            {busy ? 'Issuing…' : 'Issue invite code'}
          </Button>
        </div>
      </form>
    </div>
  );
}
