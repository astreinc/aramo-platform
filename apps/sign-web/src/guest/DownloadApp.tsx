import { useEffect, useState } from 'react';

import { EndState, Header, base64ToBlobUrl } from './App.js';
import { Btn } from './controls.js';
import { SignApiError, signApi, type ExecutedCopy } from './sign-api.js';

// Aramo Sign launch — sign.aramo.ai/d/:token: the signer's signed copy, reached
// from the completion email. Authorized by the time-limited access token in the
// link (not a signing session, not an account). Same rules as the signing app: no
// navigation into any Aramo app, no organization branding beyond the header.

function tokenFromPath(): string {
  const m = /\/d\/([^/?#]+)/.exec(window.location.pathname);
  return m !== null && m[1] !== undefined ? decodeURIComponent(m[1]) : '';
}

function fileName(title: string, suffix: string): string {
  const base = title.replace(/\.pdf$/i, '').replace(/[^\w .-]+/g, '').trim() || 'document';
  return `${base}${suffix}.pdf`;
}

type State = { kind: 'loading' } | { kind: 'ready'; copy: ExecutedCopy } | { kind: 'invalid' } | { kind: 'expired' } | { kind: 'error' };

export function DownloadApp(): JSX.Element {
  const [token] = useState(tokenFromPath);
  const [state, setState] = useState<State>(token.length === 0 ? { kind: 'invalid' } : { kind: 'loading' });

  useEffect(() => {
    if (token.length === 0) return;
    signApi
      .executed(token)
      .then((copy) => setState({ kind: 'ready', copy }))
      .catch((e: unknown) => {
        if (e instanceof SignApiError && e.code === 'SIGNING_SESSION_EXPIRED') setState({ kind: 'expired' });
        else if (e instanceof SignApiError && e.code === 'SIGNING_SESSION_INVALID') setState({ kind: 'invalid' });
        else setState({ kind: 'error' });
      });
  }, [token]);

  const save = (b64: string, name: string) => {
    const url = base64ToBlobUrl(b64, 'application/pdf');
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  if (state.kind === 'loading')
    return (
      <>
        <Header />
        <main className="sg-center" aria-busy="true">
          <p className="sg-muted">Getting your signed copy…</p>
        </main>
      </>
    );
  if (state.kind === 'invalid')
    return (
      <>
        <Header />
        <EndState tone="error" title="This download link isn't valid" body="Open it again from your completion email, or ask the sender for a copy." />
      </>
    );
  if (state.kind === 'expired')
    return (
      <>
        <Header />
        <EndState tone="muted" title="This download link has expired" body="Download links work for a limited time. Ask the sender for a copy of the signed document." />
      </>
    );
  if (state.kind === 'error')
    return (
      <>
        <Header />
        <EndState tone="error" title="Something went wrong" body="We couldn't get your signed copy. Try the link from your email again later." />
      </>
    );

  const { copy } = state;
  return (
    <>
      <Header />
      <main className="sg-center">
        <div className="sg-card" data-testid="sg-download">
          <div className="sg-eyebrow">Signed document</div>
          <h1>{copy.subject}</h1>
          {copy.completed_at ? <p className="sg-muted">Completed {new Date(copy.completed_at).toLocaleString()}</p> : null}
          {copy.documents.map((d, i) => (
            <Btn key={i} className="sg-btn--block" onClick={() => save(d.executed_base64, fileName(d.title, ' (signed)'))}>
              Download {d.title}
            </Btn>
          ))}
          {copy.certificate_base64 !== null ? (
            <Btn variant="quiet" className="sg-btn--block" onClick={() => save(copy.certificate_base64!, fileName(copy.subject, ' — certificate of completion'))}>
              Download certificate of completion
            </Btn>
          ) : null}
        </div>
      </main>
    </>
  );
}
