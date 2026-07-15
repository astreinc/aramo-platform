import { useState } from 'react';
import { Button, Card, FormField, InlineAlert } from '@aramo/fe-foundation';

import { portalApi } from './portal-api';

import './login.css';

// Portal P1 PR-3 — the passwordless portal login landing.
//
// Email entry → POST /auth/portal/request-link → a NEUTRAL confirmation shown
// unconditionally. Per Portal P1 ruling 2 the request is oracle-resistant: the
// response is byte-identical whether the address is eligible, ineligible, or
// malformed, and the UI never branches on it — it always shows the same "if this
// address is known, a link has been sent" message. A network error is swallowed
// to the SAME confirmation (no eligibility signal leaks through an error state).
//
// This same page is the session-expired landing: when the shared session lapses,
// App renders LoginPage in place of the records view.
export function LoginPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setPending(true);
    try {
      await portalApi.requestLink(email);
    } catch {
      // Swallow: the outcome is identical on success or failure — showing a
      // failure here would be an eligibility/aliveness oracle. Same confirmation.
    } finally {
      setPending(false);
      setSubmitted(true);
    }
  }

  if (submitted) {
    return (
      <div className="po-auth">
        <Card title="Check your email">
          <InlineAlert variant="success">
            If that address is known to Aramo, a sign-in link has been sent. Open
            the link on this device to continue.
          </InlineAlert>
        </Card>
      </div>
    );
  }

  return (
    <div className="po-auth">
      <Card
        title="Sign in to your Aramo portal"
        footer={
          <Button
            type="submit"
            form="po-login-form"
            variant="primary"
            disabled={pending || email.trim().length === 0}
          >
            {pending ? 'Sending…' : 'Send me a sign-in link'}
          </Button>
        }
      >
        <p className="po-auth__lede">
          Enter your email and we'll send you a secure sign-in link — no password
          needed.
        </p>
        <form id="po-login-form" onSubmit={handleSubmit}>
          <FormField label="Email">
            <input
              className="tc-input"
              type="email"
              name="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </FormField>
        </form>
      </Card>
    </div>
  );
}
