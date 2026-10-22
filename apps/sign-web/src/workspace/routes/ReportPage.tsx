import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Button, TextArea } from '@aramo/fe-foundation';

import { Alert, CardTitle, PrimaryBtn, SuIcon, type IconName, type Tone } from './signup-ui';

// Aramo Sign Personal §6.4 — "Report this email". Every signing email from a
// Personal sender links here with a token in the URL FRAGMENT (#token=…, never
// sent in a request line or a server log). No sign-in: the recipient picks a
// reason, may add a note, and the backend weighs the report (POST /v1/sign/report).
// Layout per the v1 signup design ("Report this email" frame).

/**
 * The reasons offered (design: Phishing · Impersonation · Spam · Something else),
 * each sent as its backend key. The backend also accepts `unknown_sender`; the
 * design folds that case into Spam ("I didn't expect or want this document").
 */
export const REPORT_REASONS: readonly { key: string; label: string; sub: string }[] = [
  { key: 'phishing', label: 'Phishing', sub: 'It asks for passwords, payment or personal details' },
  {
    key: 'impersonation',
    label: 'Impersonation',
    sub: 'It pretends to be a person or company it isn’t',
  },
  { key: 'spam', label: 'Spam', sub: 'I didn’t expect or want this document' },
  { key: 'other', label: 'Something else', sub: 'Tell us below' },
];

export function reportTokenFromHash(hash: string = window.location.hash): string | null {
  const t = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return t !== null && t.length >= 16 ? t : null;
}

type State = 'form' | 'sent' | 'already' | 'invalid';

function Frame({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div className="su su--grey" data-testid={testId}>
      <header className="su-head">
        <span className="su-head__name">Aramo Sign</span>
      </header>
      <main className="su-center">
        <section className="su-panel" aria-live="polite">
          {children}
        </section>
      </main>
    </div>
  );
}

function Tile({ tone, icon }: { tone: Tone; icon: IconName }) {
  return (
    <span className={`su-tile su-tile--${tone}`} aria-hidden="true">
      <SuIcon name={icon} />
    </span>
  );
}

export function ReportPage() {
  const [token] = useState(() => reportTokenFromHash());
  const [state, setState] = useState<State | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    // Drop the token from the address bar (history, screenshots) once read.
    if (window.location.hash !== '')
      window.history.replaceState(null, '', window.location.pathname);
    setState(token === null ? 'invalid' : 'form');
  }, [token]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (token === null || reason === '') return;
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
        if (res.status === 404 || res.status === 410 || res.status === 400)
          return setState('invalid');
        if (res.status === 429)
          return setError('Too many reports from this connection. Try again later.');
        setError('We couldn’t send your report. Try again.');
      })
      .catch(() => setError('We couldn’t send your report. Check your connection and try again.'))
      .finally(() => setBusy(false));
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const d =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? 1
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? -1
          : 0;
    if (d === 0) return;
    e.preventDefault();
    const next = REPORT_REASONS[(i + d + REPORT_REASONS.length) % REPORT_REASONS.length];
    if (next === undefined) return;
    setReason(next.key);
    refs.current[next.key]?.focus();
  };

  if (state === null) {
    return (
      <Frame testId="report-loading">
        <p className="su-hint" role="status">
          Loading…
        </p>
      </Frame>
    );
  }
  if (state === 'invalid') {
    return (
      <Frame testId="report-invalid">
        <Tile tone="amber" icon="warn" />
        <CardTitle
          title="This report link can’t be used"
          sub="Open “Report this email” again from the email you received. If the link still doesn’t work, the report may already be closed."
        />
      </Frame>
    );
  }
  if (state === 'sent' || state === 'already') {
    return (
      <Frame testId="report-thanks">
        <Tile tone="green" icon="check" />
        <CardTitle
          title="Thanks — we’ll look into it"
          sub={
            <>
              {state === 'already'
                ? 'We already have your report about this email. '
                : 'Your report was sent. '}
              You don’t need to do anything else. Don’t open links or sign documents from an email
              you don’t trust.
            </>
          }
        />
      </Frame>
    );
  }
  return (
    <Frame testId="report-form">
      <Tile tone="red" icon="flag" />
      <CardTitle
        title="Report this email"
        sub="You opened this from a signing email. You don’t need an account to report it."
      />
      <form className="su-stack" onSubmit={submit} noValidate>
        <div className="su-field">
          <span className="su-label" id="report-reason-label" style={{ marginBottom: 8 }}>
            What’s wrong with this email?
          </span>
          <div className="su-reasons" role="radiogroup" aria-labelledby="report-reason-label">
            {REPORT_REASONS.map((r, i) => (
              <Button
                key={r.key}
                unstyled
                ref={(el) => {
                  refs.current[r.key] = el;
                }}
                className="su-reason"
                role="radio"
                aria-checked={reason === r.key}
                tabIndex={reason === r.key || (reason === '' && i === 0) ? 0 : -1}
                onClick={() => setReason(r.key)}
                onKeyDown={(e) => onKey(e, i)}
                data-testid={`report-reason-${r.key}`}
              >
                <span className="su-type__radio" aria-hidden="true" />
                <span>
                  <span className="su-reason__label">{r.label}</span>
                  <span className="su-reason__sub">{r.sub}</span>
                </span>
              </Button>
            ))}
          </div>
        </div>
        <div className="su-field">
          <label className="su-label" htmlFor="report-note">
            Anything else? <span className="su-label__opt">(optional)</span>
          </label>
          <TextArea
            unstyled
            id="report-note"
            className="su-textarea"
            rows={3}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {error !== null ? <Alert>{error}</Alert> : null}
        <PrimaryBtn
          type="submit"
          block
          disabled={busy || reason === ''}
          data-testid="report-submit"
        >
          {busy ? 'Sending…' : 'Send report'}
        </PrimaryBtn>
      </form>
    </Frame>
  );
}
