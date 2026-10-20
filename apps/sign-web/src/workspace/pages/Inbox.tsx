import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { logout, useToast } from '@aramo/fe-foundation';

import { errorMessage, inboxApi, tokenFromSigningLink, type InboxItem } from '../api';
import { Btn, TextIn } from '../ui';

// Sign Unified Product S-7 — "Waiting for me": documents other organizations sent
// to the signed-in user, with recipient-only access (directive §4.6, refinement B).
// A document joins the inbox only when the user adds the signing link from their
// email while signed in, and the link's recipient email is theirs. Signing opens
// the same secure signing page as the email; nothing of the sender organization
// beyond its name is shown.

function when(iso: string | null): string {
  return iso === null ? '—' : new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// `embedded`: rendered inside the workspace shell (the sidebar provides navigation and
// sign-out). Standalone (/inbox) is for a signed-in recipient without a Sign workspace.
export function InboxPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { show: toast } = useToast();
  const [data, setData] = useState<{ waiting: InboxItem[]; completed: InboxItem[]; other: InboxItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    inboxApi
      .list()
      .then(setData)
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  const add = async () => {
    const token = tokenFromSigningLink(link);
    if (token === null) {
      toast('Paste the “Review and sign” link from your email');
      return;
    }
    setBusy(true);
    try {
      await inboxApi.claim(token);
      setLink('');
      toast('Added to your inbox');
      load();
    } catch (e) {
      toast(errorMessage(e, 'That link could not be added'));
    } finally {
      setBusy(false);
    }
  };

  const sign = async (i: InboxItem) => {
    try {
      window.location.assign((await inboxApi.sign(i.id)).signing_url);
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  const copy = async (i: InboxItem) => {
    try {
      window.open((await inboxApi.signedCopy(i.id)).download_url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  const remove = async (i: InboxItem) => {
    try {
      await inboxApi.remove(i.id);
      load();
    } catch (e) {
      toast(errorMessage(e));
    }
  };

  const row = (i: InboxItem) => (
    <tr key={i.id} data-testid={`inbox-row-${i.id}`}>
      <td>
        <strong>{i.subject}</strong>
        <div className="sg-muted">{i.from ?? 'An Aramo Sign sender'}</div>
      </td>
      <td className="sg-muted">{when(i.sent_at)}</td>
      <td className="sg-muted">{i.can_sign ? `Sign by ${when(i.expires_at)}` : i.can_download ? `Completed ${when(i.completed_at)}` : i.envelope_status.toLowerCase()}</td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        {i.can_sign ? (
          <Btn variant="primary" size="sm" onClick={() => void sign(i)}>
            Sign
          </Btn>
        ) : null}
        {i.can_download ? (
          <Btn size="sm" onClick={() => void copy(i)}>
            Signed copy
          </Btn>
        ) : null}{' '}
        <Btn size="sm" variant="ghost" onClick={() => void remove(i)} aria-label={`Remove ${i.subject} from your inbox`}>
          Remove
        </Btn>
      </td>
    </tr>
  );

  const section = (title: string, items: InboxItem[], empty: string, testId: string) => (
    <section className="sg-card" data-testid={testId} style={{ marginBottom: 16 }}>
      <div className="sg-card__head">{title}</div>
      {items.length === 0 ? (
        <div className="sg-empty">{empty}</div>
      ) : (
        <table className="sg-table">
          <tbody>{items.map(row)}</tbody>
        </table>
      )}
    </section>
  );

  return (
    <div className="sg sg-page sg-page--wide" data-testid="inbox">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <h1 className="sg-h1" style={{ margin: 0 }}>
          Waiting for me
        </h1>
        {embedded ? null : (
          <span style={{ marginLeft: 'auto' }}>
            <Link to="/">Aramo Sign</Link> · <a onClick={() => void logout()} href="#sign-out">Sign out</a>
          </span>
        )}
      </div>
      <section className="sg-card" style={{ marginBottom: 16 }}>
        <div className="sg-card__body">
          <label className="sg-label" htmlFor="inbox-link">
            Add a document you received by email
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <TextIn id="inbox-link" placeholder="Paste the “Review and sign” link" value={link} onChange={(e) => setLink(e.target.value)} />
            <Btn variant="primary" disabled={busy || link.trim() === ''} onClick={() => void add()}>
              Add
            </Btn>
          </div>
          <p className="sg-help" style={{ marginTop: 8 }}>
            Only documents sent to your own email address can be added. The emailed link keeps working.
          </p>
        </div>
      </section>
      {error !== null ? <div className="sg-note">{error}</div> : null}
      {data === null && error === null ? <div className="sg-muted">Loading…</div> : null}
      {data !== null ? (
        <>
          {section('To sign', data.waiting, 'Nothing is waiting for your signature.', 'inbox-waiting')}
          {section('Completed', data.completed, 'No completed documents yet.', 'inbox-completed')}
          {data.other.length > 0 ? section('Other', data.other, '', 'inbox-other') : null}
        </>
      ) : null}
    </div>
  );
}
