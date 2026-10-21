import { useEffect, useState } from 'react';

import { delegateApi, tokenFromHash, type DelegateApi, type DelegateView } from '../domain-api';
import { Btn } from '../ui';
import { CONFLICT_MESSAGE } from '../pages/DomainCard';

// Domain-Enforcement P3 (LOCKED) §5 — the public page an IT / domain administrator
// opens from the emailed link (/domain-verification#token=…). No sign-in: the
// token from the URL fragment is posted in a request body. The page shows the one
// DNS record to publish and a Check button — nothing else of Aramo.

type State =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'ready'; view: DelegateView };

export function DomainDelegatePage({ api = delegateApi, hash }: { api?: DelegateApi; hash?: string }) {
  const [token] = useState(() => tokenFromHash(hash ?? window.location.hash));
  const [state, setState] = useState<State>(token === null ? { kind: 'invalid' } : { kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (token === null) return undefined;
    let live = true;
    api
      .view(token)
      .then((view) => live && setState({ kind: 'ready', view }))
      .catch(() => live && setState({ kind: 'invalid' }));
    return () => {
      live = false;
    };
  }, [api, token]);

  const check = async () => {
    if (token === null) return;
    setBusy(true);
    setNotice(null);
    try {
      const view = await api.check(token);
      setState({ kind: 'ready', view });
      if (view.status !== 'VERIFIED') setNotice('No matching record yet. DNS changes can take minutes to hours to appear; try again later.');
    } catch {
      setState({ kind: 'invalid' });
    } finally {
      setBusy(false);
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => setNotice('Copied'),
      () => undefined,
    );
  };

  return (
    <div className="sg sg-center" data-testid="domain-delegate-page">
      <div className="sg-state" style={{ maxWidth: 640, textAlign: 'left' }}>
        <div className="sg-state__mark">A</div>
        <h1 className="sg-h1">Verify a domain for Aramo</h1>
        {state.kind === 'loading' ? <div className="sg-muted">Loading…</div> : null}
        {state.kind === 'invalid' ? (
          <div className="sg-note" data-testid="domain-delegate-invalid">
            This link is invalid or has expired. Ask the person who sent it for a new one.
          </div>
        ) : null}
        {state.kind === 'ready' ? (
          <div className="sg-grid" style={{ gap: 12 }}>
            <div className="sg-lede">
              An organization asked you to prove it controls <strong>{state.view.domain}</strong> on Aramo by publishing one DNS TXT record.
            </div>
            {notice !== null ? <div className="sg-note">{notice}</div> : null}
            {state.view.status === 'VERIFIED' ? (
              state.view.domain_claim_conflict ? (
                <div className="sg-note" data-testid="domain-delegate-conflict">
                  The domain is verified. {CONFLICT_MESSAGE}
                </div>
              ) : (
                <div className="sg-note" data-testid="domain-delegate-verified">
                  Done — {state.view.domain} is verified. You can remove the TXT record later if you like; nothing else is needed.
                </div>
              )
            ) : (
              <>
                <div className="sg-kv">
                  <div>
                    <div className="sg-kv__k">Type</div>
                    <div className="sg-kv__v">TXT</div>
                  </div>
                  <div>
                    <div className="sg-kv__k">Name</div>
                    <div className="sg-kv__v" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <code data-testid="domain-delegate-name" style={{ wordBreak: 'break-all' }}>
                        {state.view.record.name}
                      </code>
                      {state.view.record.name !== null ? (
                        <Btn size="sm" type="button" onClick={() => copy(state.view.record.name as string)}>
                          Copy
                        </Btn>
                      ) : null}
                    </div>
                  </div>
                  <div>
                    <div className="sg-kv__k">Value</div>
                    <div className="sg-kv__v" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <code data-testid="domain-delegate-value" style={{ wordBreak: 'break-all' }}>
                        {state.view.record.value}
                      </code>
                      {state.view.record.value !== null ? (
                        <Btn size="sm" type="button" onClick={() => copy(state.view.record.value as string)}>
                          Copy
                        </Btn>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div>
                  <Btn variant="primary" type="button" disabled={busy} onClick={() => void check()} data-testid="domain-delegate-check">
                    {busy ? 'Checking…' : 'Check now'}
                  </Btn>
                </div>
                <p className="sg-help" style={{ margin: 0 }}>
                  Add the record at the DNS provider for {state.view.domain}, then select Check now. This link gives you no other access to Aramo.
                </p>
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
