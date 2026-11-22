import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { logout, useToast } from '@aramo/fe-foundation';
import { inboxActionsOf } from '@aramo/sign-client';

import { INBOX_ITEM_CHANGED, errorMessage, inboxApi, isInboxItemNotFound, isUpcoming, tokenFromSigningLink, type InboxItem } from '../api';
import { Btn, TextIn } from '../ui';

// Sign Unified Product S-7 — "Waiting for me": documents other organizations sent
// to the signed-in user, with recipient-only access (directive §4.6, refinement B).
// A document joins the inbox only when the user adds the signing link from their
// email while signed in, and the link's recipient email is theirs. Signing opens
// the same secure signing page as the email; nothing of the sender organization
// beyond its name is shown.
//
// W2 (Inbox Discovery, A3.1-A3.4) — the server also lists envelopes sent to the
// user's verified account email ('discovered' items). They render exactly like added
// ones; their id is an opaque short-lived handle the page passes back unchanged. An
// item whose turn is later ('upcoming') shows under "Upcoming", never under To sign.

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
      // W2 — a changed or expired discovered item: reload the inbox once (fresh handles).
      if (isInboxItemNotFound(e)) {
        toast(INBOX_ITEM_CHANGED);
        load();
        return;
      }
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
  // M-A17 — "Delete from my inbox": any received item, any state, to this user's Deleted
  // list (restorable). The sender and other recipients are unaffected; the emailed link
  // keeps working.
  const [deleted, setDeleted] = useState<InboxItem[] | null>(null);
  const loadDeleted = useCallback(() => {
    inboxApi.deleted().then(
      (d) => setDeleted([...d.waiting, ...d.completed, ...d.other]),
      (e: unknown) => toast(errorMessage(e)),
    );
  }, [toast]);
  const remove = async (i: InboxItem) => {
    try {
      await inboxApi.removeFromInbox(i.id);
      toast('Moved to Deleted. The sender’s envelope isn’t affected.');
      load();
      if (deleted !== null) loadDeleted();
    } catch (e) {
      if (isInboxItemNotFound(e)) {
        toast(INBOX_ITEM_CHANGED);
        load();
        return;
      }
      toast(errorMessage(e));
    }
  };
  const restore = async (i: InboxItem) => {
    try {
      await inboxApi.returnToInbox(i.id);
      toast('Restored to your inbox');
      load();
      loadDeleted();
    } catch (e) {
      toast(errorMessage(e));
    }
  };

  // Client Rule Consolidation C3 (audit row 12) — Sign, Signed copy and Delete show only when
  // the server's item `actions` allows them.
  const row = (i: InboxItem) => {
    const actions = inboxActionsOf(i);
    return (
    <tr key={i.id} data-testid={`inbox-row-${i.id}`}>
      <td>
        <strong>{i.subject}</strong>
        <div className="sg-muted">{i.from ?? 'An Aramo Sign sender'}</div>
      </td>
      <td className="sg-muted">{when(i.sent_at)}</td>
      <td className="sg-muted">
        {actions.sign ? `Sign by ${when(i.expires_at)}` : isUpcoming(i) ? 'Not your turn yet' : actions.download ? `Completed ${when(i.completed_at)}` : i.envelope_status.toLowerCase()}
      </td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        {actions.sign ? (
          <Btn variant="primary" size="sm" onClick={() => void sign(i)}>
            Sign
          </Btn>
        ) : null}
        {actions.download ? (
          <Btn size="sm" onClick={() => void copy(i)}>
            Signed copy
          </Btn>
        ) : null}{' '}
        {/* M-A17 — every received item (added or listed automatically), any state. */}
        {actions.delete ? (
          <Btn size="sm" variant="ghost" onClick={() => void remove(i)} aria-label={`Delete ${i.subject} from your inbox`} data-testid={`inbox-delete-${i.id}`}>
            Delete
          </Btn>
        ) : null}
      </td>
    </tr>
    );
  };

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
          {section('To sign', data.waiting.filter((i) => !isUpcoming(i)), 'Nothing is waiting for your signature.', 'inbox-waiting')}
          {data.waiting.some(isUpcoming) ? section('Upcoming', data.waiting.filter(isUpcoming), '', 'inbox-upcoming') : null}
          {section('Completed', data.completed, 'No completed documents yet.', 'inbox-completed')}
          {data.other.length > 0 ? section('Other', data.other, '', 'inbox-other') : null}
          {/* M-A17 — the user's own Deleted list, with Restore. */}
          {deleted === null ? (
            <Btn variant="ghost" size="sm" onClick={loadDeleted} data-testid="inbox-show-deleted">
              Show deleted
            </Btn>
          ) : (
            <section className="sg-card" data-testid="inbox-deleted" style={{ marginBottom: 16 }}>
              <div className="sg-card__head">Deleted</div>
              {deleted.length === 0 ? (
                <div className="sg-empty">Nothing deleted.</div>
              ) : (
                <table className="sg-table">
                  <tbody>
                    {deleted.map((i) => (
                      <tr key={i.id} data-testid={`inbox-deleted-row-${i.id}`}>
                        <td>
                          <strong>{i.subject}</strong>
                          <div className="sg-muted">{i.from ?? 'An Aramo Sign sender'}</div>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {inboxActionsOf(i).restore ? (
                            <Btn size="sm" onClick={() => void restore(i)} data-testid={`inbox-restore-${i.id}`}>
                              Restore
                            </Btn>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}
        </>
      ) : null}
    </div>
  );
}
