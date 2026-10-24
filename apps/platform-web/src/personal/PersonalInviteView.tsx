import { useState, type FormEvent } from 'react';
import { Button, useOptionalToast } from '@aramo/fe-foundation';

import { FieldText, OneTimeSecret, formatClock, formatDate, formatRelative } from '../components';
import { platformApi, type PersonalInvite } from '../platform-api';

import { INVITE_EMAIL_REQUIRED, inviteErrorText } from './personal-review-model';
import './personal.css';

// PLATFORM-UX-1 F-6 (handoff §8.2; amendment 5) — Sign Personal pilot invites:
// one-time codes bound to one email (expiring after 7 days, capped by
// SIGN_PERSONAL_PILOT_CAP). The code is shown ONCE (the backend stores only its
// hash). There is no read endpoint for seat usage, so no seat count is shown:
// the cap surfaces only as the `personal_pilot_full` refusal (data gap, R-13).

/** "7 Nov 2026, 15:00 UTC · in 7 days" (the design's expiry line). */
export function expiryLine(iso: string | null, now: Date = new Date()): string | null {
  if (iso === null) return null;
  const date = formatDate(iso);
  if (date === '—') return null;
  return `${date}, ${formatClock(iso)} · ${formatRelative(iso, now)}`;
}

export function PersonalInviteView() {
  const toast = useOptionalToast();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<PersonalInvite | null>(null);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const value = email.trim();
    if (value === '') {
      setError(INVITE_EMAIL_REQUIRED);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setIssued(await platformApi.issuePersonalInvite({ email: value }));
      setEmail('');
    } catch (err) {
      setError(inviteErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pw-sp" data-testid="personal-invites">
      <div className="pw-sp-head">
        <h1 className="pw-sp-title">Sign Personal pilot invites</h1>
        <p className="pw-sp-intro">Send a one-time code that lets someone create a Sign Personal account during the pilot.</p>
      </div>
      <div className="pw-sp-invgrid">
        <section className="pw-sp-panel" aria-labelledby="pw-sp-new-invite">
          <div className="pw-sp-panel__head">
            <h2 id="pw-sp-new-invite" className="pw-sp-panel__title">
              New invite
            </h2>
          </div>
          {error !== null ? (
            <div role="alert" className="pw-alert pw-alert--error pw-sp-panel__alert">
              {error}
            </div>
          ) : null}
          <form noValidate onSubmit={(e) => void submit(e)}>
            <FieldText
              label="Email"
              type="email"
              value={email}
              placeholder="name@example.com"
              onChange={(v) => {
                setEmail(v);
                setError(null);
              }}
            />
            <div className="pw-sp-panel__actions">
              <Button
                unstyled
                type="submit"
                className="pw-btn pw-btn--normal"
                disabled={busy}
                aria-busy={busy || undefined}
                data-testid="personal-invite-submit"
              >
                Create invite code
              </Button>
            </div>
          </form>
        </section>
        {issued !== null ? (
          <div data-testid="personal-invite-issued">
            <OneTimeSecret
              secret={issued.code}
              recipient={issued.email}
              expires={expiryLine(issued.expires_at)}
              onCopied={() => toast.show('Code copied.')}
              onDismiss={() => setIssued(null)}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
