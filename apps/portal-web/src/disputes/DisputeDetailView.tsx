import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ApiError,
  Button,
  Card,
  Dialog,
  InlineAlert,
} from '@aramo/fe-foundation';

import { portalApi, type PortalDisputeDetail } from '../portal-api';

import { DISPUTE_STATUS_LABELS } from './DisputesListView';

// Portal P3c (§PR-3) — one dispute's detail. Status + opened date + the
// talent's statements, plus the plain-language resolution note once closed
// (directive ruling 6 — the outcome the talent sees). While open (OPEN or
// UNDER_REVIEW) the talent may respond (append a statement) or withdraw.
// Oracle discipline: an id out of the caller's chain is a uniform 404, surfaced
// honestly — no tenant/reviewer identity, no internal queue state.

const OPEN_STATES = new Set(['OPEN', 'UNDER_REVIEW']);

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function DisputeDetailView() {
  const { id } = useParams<{ id: string }>();
  const [dispute, setDispute] = useState<PortalDisputeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Respond (append) + withdraw state.
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);

  const load = useCallback(async () => {
    if (id === undefined) return;
    setLoading(true);
    setError(null);
    try {
      setDispute(await portalApi.getDispute(id));
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : 'Failed to load this dispute.',
      );
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitReply = useCallback(async () => {
    if (id === undefined || reply.trim() === '') return;
    setBusy(true);
    setError(null);
    const key = crypto.randomUUID();
    try {
      await portalApi.respondDispute(id, reply.trim(), key);
      setReply('');
      await load();
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : 'Your response could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }, [id, reply, load]);

  const submitWithdraw = useCallback(async () => {
    if (id === undefined) return;
    setBusy(true);
    setError(null);
    const key = crypto.randomUUID();
    try {
      await portalApi.withdrawDispute(id, key);
      setConfirmWithdraw(false);
      await load();
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : 'The dispute could not be withdrawn.',
      );
    } finally {
      setBusy(false);
    }
  }, [id, load]);

  const isOpen = dispute !== null && OPEN_STATES.has(dispute.status);

  return (
    <div className="po-page">
      <div className="po-page__head">
        <h1 className="po-page__title">Dispute</h1>
        <Link className="rc-link-strong" to="/disputes">
          ← Your disputes
        </Link>
      </div>

      {loading && <p className="po-page__lede">Loading…</p>}
      {error !== null && <InlineAlert variant="error">{error}</InlineAlert>}

      {dispute !== null && (
        <>
          <Card title="Status">
            <dl className="po-facts">
              <dt>Status</dt>
              <dd>
                {DISPUTE_STATUS_LABELS[dispute.status] ?? dispute.status}
              </dd>
              <dt>Opened</dt>
              <dd>{fmtDateTime(dispute.opened_at)}</dd>
            </dl>
            {dispute.resolution_note !== null && (
              <>
                <h2 className="po-consent-history__title">Resolution</h2>
                <p className="po-consent-text">{dispute.resolution_note}</p>
              </>
            )}
          </Card>

          <Card title="Your statements">
            {dispute.statements.length === 0 ? (
              <p className="po-page__lede">No statements yet.</p>
            ) : (
              <ul className="po-consent-history">
                {dispute.statements.map((s, i) => (
                  <li key={`${s.created_at}:${i}`}>
                    <span className="po-consent-history__when">
                      {fmtDateTime(s.created_at)}
                    </span>{' '}
                    {s.statement}
                  </li>
                ))}
              </ul>
            )}

            {isOpen && (
              <div className="po-dispute-respond">
                <textarea
                  className="po-textarea"
                  rows={3}
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder="Add to your dispute…"
                  aria-label="Add to your dispute"
                  maxLength={4000}
                  disabled={busy}
                />
                <div className="po-dispute-actions">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void submitReply()}
                    disabled={busy || reply.trim() === ''}
                  >
                    Add response
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmWithdraw(true)}
                    disabled={busy}
                  >
                    Withdraw dispute
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </>
      )}

      <Dialog
        open={confirmWithdraw}
        onOpenChange={(o) => {
          if (!o && !busy) setConfirmWithdraw(false);
        }}
        title="Withdraw dispute"
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setConfirmWithdraw(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="secondary"
              onClick={() => void submitWithdraw()}
              disabled={busy}
            >
              Withdraw
            </Button>
          </>
        }
      >
        <p>
          Withdrawing closes this dispute. You can open a new one later if you
          need to.
        </p>
      </Dialog>
    </div>
  );
}
