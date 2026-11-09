import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ApiError,
  AppleLogo,
  fetchSignInMethods,
  GoogleLogo,
  isFederatedIdp,
  linkProviderUrl,
  linkRefusalMessage,
  MicrosoftLogo,
  PROVIDER_NAME,
  removeSignInMethod,
  type FederatedIdp,
  type SignInMethod,
} from '@aramo/fe-foundation';

import { Btn, ErrorBox, fmtDate } from '../ui';
import { useWorkspace } from '../workspace';

// Apple Go-Live A1 L-3 path 1 / L-7 — Settings → Sign-in methods. The list of
// providers linked to this Aramo account, "Add <provider>" (proof (c): the user
// is signed in; the auth-service callback returns here with `?linked=<p>` or
// `?link_error=<reason>`), and Remove with a confirmation. The auth-service
// refuses to remove the last method (409 `last_sign_in_method`). Which providers
// a tenant may use is the auth-service's decision (A1 L-5); a refusal comes back
// as `link_error` and is shown in plain words.

/** Personal accounts may use Google and Apple (Apple Go-Live R-4); Business may use all three. */
function offered(personal: boolean): readonly FederatedIdp[] {
  return personal ? ['google', 'apple'] : ['microsoft', 'google', 'apple'];
}

function Logo({ idp }: { idp: FederatedIdp }) {
  if (idp === 'apple') return <AppleLogo size={16} />;
  return idp === 'microsoft' ? <MicrosoftLogo /> : <GoogleLogo />;
}

type Notice = { tone: 'ok' | 'error'; text: string } | null;

export function SignInMethodsSection({
  loader = () => fetchSignInMethods(),
  remover = (idp: FederatedIdp) => removeSignInMethod(idp),
  onNavigate = (url: string) => window.location.assign(url),
}: {
  loader?: () => Promise<SignInMethod[]>;
  remover?: (idp: FederatedIdp) => Promise<void>;
  onNavigate?: (url: string) => void;
} = {}) {
  const { ctx } = useWorkspace();
  const location = useLocation();
  const navigate = useNavigate();
  const [methods, setMethods] = useState<SignInMethod[] | null | 'error'>(null);
  const [confirming, setConfirming] = useState<FederatedIdp | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(() => {
    const q = new URLSearchParams(location.search);
    const linked = q.get('linked');
    if (isFederatedIdp(linked)) return { tone: 'ok', text: `${PROVIDER_NAME[linked]} is connected. You can now sign in with it.` };
    const err = q.get('link_error');
    if (err !== null) return { tone: 'error', text: linkRefusalMessage(err, null) };
    return null;
  });

  // Clear the callback's `?linked=` / `?link_error=` so a reload doesn't repeat the notice.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (!q.has('linked') && !q.has('link_error')) return;
    q.delete('linked');
    q.delete('link_error');
    const rest = q.toString();
    navigate({ pathname: location.pathname, search: rest.length > 0 ? `?${rest}` : '' }, { replace: true });
    // Once, on mount.
  }, []);

  const load = () => {
    loader()
      .then(setMethods)
      .catch(() => setMethods('error'));
  };
  useEffect(load, []);

  const remove = async (idp: FederatedIdp) => {
    setBusy(true);
    setNotice(null);
    try {
      await remover(idp);
      setConfirming(null);
      setNotice({ tone: 'ok', text: `${PROVIDER_NAME[idp]} was removed. You can no longer sign in with it.` });
      load();
    } catch (e) {
      setConfirming(null);
      setNotice({
        tone: 'error',
        text:
          e instanceof ApiError && e.status === 409
            ? 'This is your only sign-in method, so it can’t be removed. Add another one first.'
            : `We couldn’t remove ${PROVIDER_NAME[idp]}. Try again.`,
      });
    } finally {
      setBusy(false);
    }
  };

  const personal = ctx.tenant.kind === 'PERSONAL';
  const list = Array.isArray(methods) ? methods : [];
  const addable = offered(personal).filter((p) => !list.some((m) => m.idp === p));

  return (
    <section className="sg-card" data-testid="settings-sign-in-methods">
      <div className="sg-card__head">Sign-in methods</div>
      <div className="sg-card__body sg-grid" style={{ gap: 12 }}>
        <p className="sg-help" style={{ margin: 0 }}>
          The accounts you can use to sign in to Aramo. They must use your account’s email, or be added here while you’re signed in.
        </p>
        {notice !== null ? (
          notice.tone === 'ok' ? (
            <div className="sg-note" role="status" data-testid="sign-in-methods-notice">
              {notice.text}
            </div>
          ) : (
            <ErrorBox>
              <span data-testid="sign-in-methods-notice">{notice.text}</span>
            </ErrorBox>
          )
        ) : null}
        {methods === null ? (
          <p className="sg-muted" role="status">
            Loading…
          </p>
        ) : methods === 'error' ? (
          <ErrorBox>We couldn’t load your sign-in methods. Try again later.</ErrorBox>
        ) : (
          <div data-testid="sign-in-methods-list">
            {list.map((m) => (
              <div key={m.idp} className="sg-row" style={{ paddingLeft: 0, paddingRight: 0 }} data-testid={`sign-in-method-${m.idp}`}>
                <Logo idp={m.idp} />
                <div className="sg-row__main">
                  <div style={{ fontWeight: 600 }}>{PROVIDER_NAME[m.idp]}</div>
                  <div className="sg-muted" style={{ fontSize: 13 }}>
                    {m.email_snapshot ?? '—'}
                    {m.linked_at !== '' ? ` · Added ${fmtDate(m.linked_at)}` : ''}
                  </div>
                </div>
                {confirming === m.idp ? (
                  <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="sg-muted" style={{ fontSize: 13 }}>{`Remove ${PROVIDER_NAME[m.idp]}?`}</span>
                    <Btn size="sm" variant="danger" disabled={busy} onClick={() => void remove(m.idp)} data-testid={`sign-in-method-confirm-${m.idp}`}>
                      {busy ? 'Removing…' : 'Remove'}
                    </Btn>
                    <Btn size="sm" disabled={busy} onClick={() => setConfirming(null)}>
                      Cancel
                    </Btn>
                  </span>
                ) : (
                  <Btn size="sm" disabled={busy} onClick={() => setConfirming(m.idp)} data-testid={`sign-in-method-remove-${m.idp}`}>
                    Remove
                  </Btn>
                )}
              </div>
            ))}
            {addable.length > 0 ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                {addable.map((p) => (
                  <Btn
                    key={p}
                    size="sm"
                    onClick={() => onNavigate(linkProviderUrl(p, location.pathname))}
                    data-testid={`sign-in-method-add-${p}`}
                    {...(p === 'apple' ? { style: { background: '#000', borderColor: '#000', color: '#fff' } } : {})}
                  >
                    <Logo idp={p} /> {`Add ${PROVIDER_NAME[p]}`}
                  </Btn>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
