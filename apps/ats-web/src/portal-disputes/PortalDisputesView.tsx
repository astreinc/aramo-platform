import { useCallback, useEffect, useState } from 'react';
import { ApiError, Button, hasScope, InlineAlert, useSession, type Session } from '@aramo/fe-foundation';

import { Card } from '../ui';

import {
  correctDispute,
  getPortalDisputes,
  triageDispute,
  upholdDispute,
  type PortalDisputeItem,
} from './portal-disputes-api';

// Portal P3b (§PR-2) — the minimal tenant dispute-disposition worklist (mirrors
// IdentityAdvisoriesView conventions). Gated on identity:resolve: the reviewer
// TRIAGES a talent dispute (→ the backing evidence goes DISPUTED), then
// CORRECTS (evidence revoked) or UPHOLDS (evidence stands). PROPOSE/DISPOSE —
// the human disposes here; corrections flow through the standing trust writers.

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const OPEN_STATES = ['OPEN', 'UNDER_REVIEW'];

export function PortalDisputesView({ sessionOverride }: { sessionOverride?: Session } = {}) {
  const sessionState = useSession();
  const session =
    sessionOverride ?? (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canResolve = session !== null && hasScope(session, 'identity:resolve');

  const [disputes, setDisputes] = useState<PortalDisputeItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; action: 'correct' | 'uphold' } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await getPortalDisputes();
      setDisputes(res.disputes);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load disputes.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runTriage = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        await triageDispute(id);
        await load();
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Triage failed.');
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const confirmDisposition = useCallback(async () => {
    if (pending === null) return;
    setBusy(true);
    setError(null);
    try {
      if (pending.action === 'correct') await correctDispute(pending.id, note);
      else await upholdDispute(pending.id, note);
      setPending(null);
      setNote('');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Disposition failed.');
    } finally {
      setBusy(false);
    }
  }, [pending, note, load]);

  return (
    <div>
      <h1>Identity disputes</h1>
      <p className="rc-muted">Talent-raised disputes on verifications you furnished.</p>
      {error !== null && <InlineAlert variant="error">{error}</InlineAlert>}

      <Card>
        <table className="rc-table rc-table--comfortable">
          <thead>
            <tr>
              <th>Item</th>
              <th>Status</th>
              <th>Arrived</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(disputes ?? []).map((d) => (
              <tr key={`${d.dispute_id}:${d.subject_id}`}>
                <td>{d.item_type}</td>
                <td>{d.status}</td>
                <td>{fmtDate(d.arrived_at)}</td>
                <td>
                  {canResolve && d.status === 'OPEN' && (
                    <Button variant="secondary" size="sm" onClick={() => void runTriage(d.dispute_id)} disabled={busy}>
                      Triage
                    </Button>
                  )}
                  {canResolve && d.status === 'UNDER_REVIEW' && (
                    <>
                      <Button variant="primary" size="sm" onClick={() => setPending({ id: d.dispute_id, action: 'correct' })} disabled={busy}>
                        Correct
                      </Button>{' '}
                      <Button variant="secondary" size="sm" onClick={() => setPending({ id: d.dispute_id, action: 'uphold' })} disabled={busy}>
                        Uphold
                      </Button>
                    </>
                  )}
                  {!OPEN_STATES.includes(d.status) && <span className="rc-muted">closed</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {disputes !== null && disputes.length === 0 && <p className="rc-muted">No open disputes.</p>}
      </Card>

      {pending !== null && (
        <Card>
          <h2>{pending.action === 'correct' ? 'Correct — the item was wrong' : 'Uphold — the item stands'}</h2>
          <p className="rc-muted">
            {pending.action === 'correct'
              ? 'The disputed evidence will be revoked. Record a resolution note for the audit + the talent.'
              : 'The dispute is rejected and the evidence returns to valid. Record a resolution note.'}
          </p>
          <textarea
            className="rc-input"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Resolution note…"
            aria-label="Resolution note"
          />
          <div>
            <Button variant="ghost" onClick={() => setPending(null)} disabled={busy}>
              Cancel
            </Button>{' '}
            <Button variant="primary" onClick={() => void confirmDisposition()} disabled={busy || note.trim() === ''}>
              Confirm
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
