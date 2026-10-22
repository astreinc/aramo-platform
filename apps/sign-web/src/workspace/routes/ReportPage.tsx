import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Input } from '@aramo/fe-foundation';

import { Area, Btn, ErrorBox, Loading } from '../ui';

// Aramo Sign Personal §6.4 — "Report this email". Every signing email from a
// Personal sender links here with a token in the URL FRAGMENT (#token=…, never
// sent in a request line or a server log). No sign-in: the recipient picks a
// reason, may add a note, and the backend weighs the report (POST /v1/sign/report).

export const REPORT_REASONS: readonly { key: string; label: string }[] = [
  { key: 'phishing', label: 'It looks like phishing or a scam' },
  { key: 'impersonation', label: 'The sender is pretending to be someone else' },
  { key: 'unknown_sender', label: 'I don’t know the sender' },
  { key: 'spam', label: 'It’s unwanted or spam' },
  { key: 'other', label: 'Something else' },
];

export function reportTokenFromHash(hash: string = window.location.hash): string | null {
  const t = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return t !== null && t.length >= 16 ? t : null;
}

type State = 'form' | 'sent' | 'already' | 'invalid';

function Frame({ title, children, testId }: { title: string; children: React.ReactNode; testId: string }) {
  const h = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    h.current?.focus();
  }, [title]);
  return (
    <div className="sg sg-center" data-testid={testId}>
      <main className="sg-state" style={{ maxWidth: 480, width: '100%', textAlign: 'left' }}>
        <div className="sg-state__mark" aria-hidden="true">
          S
        </div>
        <h1 className="sg-h1" ref={h} tabIndex={-1}>
          {title}
        </h1>
        {children}
      </main>
    </div>
  );
}

export function ReportPage() {
  const [token] = useState(() => reportTokenFromHash());
  const [state, setState] = useState<State | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Drop the token from the address bar (history, screenshots) once read.
    if (window.location.hash !== '') window.history.replaceState(null, '', window.location.pathname);
    setState(token === null ? 'invalid' : 'form');
  }, [token]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (token === null) return;
    if (reason === '') {
      setError('Choose a reason.');
      return;
    }
    setBusy(true);
    setError(null);
    fetch('/v1/sign/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, reason, ...(note.trim() !== '' ? { note: note.trim() } : {}) }),
    })
      .then((res) => {
        if (res.ok) return setState('sent');
        if (res.status === 409) return setState('already');
        if (res.status === 404 || res.status === 410 || res.status === 400) return setState('invalid');
        if (res.status === 429) return setError('Too many reports from this connection. Try again later.');
        setError('We couldn’t send your report. Try again.');
      })
      .catch(() => setError('We couldn’t send your report. Check your connection and try again.'))
      .finally(() => setBusy(false));
  };

  if (state === null) return <Loading />;
  if (state === 'invalid') {
    return (
      <Frame title="This report link can’t be used" testId="report-invalid">
        <p className="sg-lede">Open “Report this email” again from the email you received. If the link still doesn’t work, the report may already be closed.</p>
      </Frame>
    );
  }
  if (state === 'sent' || state === 'already') {
    return (
      <Frame title="Thank you" testId="report-thanks">
        <p className="sg-lede">
          {state === 'already' ? 'We already have your report about this email.' : 'Your report was sent.'} Aramo reviews reports and can pause an account
          that misuses Aramo Sign.
        </p>
        <p className="sg-help">You don’t need to do anything else. Don’t sign a document you don’t trust.</p>
      </Frame>
    );
  }
  return (
    <Frame title="Report this email" testId="report-form">
      <p className="sg-lede">Tell us what’s wrong with the signing request you received. You don’t need an account.</p>
      <form className="sg-grid" style={{ gap: 12, marginTop: 12 }} onSubmit={submit} noValidate>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }} aria-describedby={error !== null ? 'report-error' : undefined}>
          <legend className="sg-label">Why are you reporting it?</legend>
          {REPORT_REASONS.map((r) => (
            <label key={r.key} className="sg-settings-row" htmlFor={`report-${r.key}`}>
              <Input unstyled type="radio" id={`report-${r.key}`} name="report-reason" value={r.key} checked={reason === r.key} onChange={() => setReason(r.key)} />
              <span>{r.label}</span>
            </label>
          ))}
        </fieldset>
        <div className="sg-field">
          <label className="sg-label" htmlFor="report-note">
            Anything else? (optional)
          </label>
          <Area id="report-note" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        {error !== null ? (
          <div id="report-error">
            <ErrorBox>{error}</ErrorBox>
          </div>
        ) : null}
        <Btn variant="primary" type="submit" disabled={busy} data-testid="report-submit">
          {busy ? 'Sending…' : 'Send report'}
        </Btn>
      </form>
    </Frame>
  );
}
