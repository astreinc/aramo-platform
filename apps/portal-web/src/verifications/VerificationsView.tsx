import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ApiError,
  Button,
  Card,
  Dialog,
  InlineAlert,
} from '@aramo/fe-foundation';

import { portalApi, type PortalVerificationItem } from '../portal-api';

// Portal P3c (§PR-3) — "Your verified identity on Aramo". The talent-level
// verification view (directive ruling 1): each item rendered as kind + status +
// dates ONLY — the "verified on Aramo" form. NO verifier, NO tenant attribution,
// NO strength numbers, NO tier/band vocabulary (the trust-class wall). An empty
// list is a VALID state (no verified identity yet), shown honestly.
//
// Open-from-item (ruling 2): each item offers "Dispute this", capturing a
// free-text statement (no reason taxonomy) and posting the item's opaque digest.
// On success the talent lands on their disputes list to see the new dispute.

function fmtDate(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// Plain-language labels; unknown values fall back to the raw token (honest, never
// invented). Trust-class fields only.
const KIND_LABELS: Record<string, string> = {
  EMAIL: 'Email',
  PHONE: 'Phone',
  PROFILE_URL: 'Profile link',
};

const STATUS_LABELS: Record<string, string> = {
  CONFIRMED: 'Verified',
  PENDING: 'In progress',
  NONE: 'Not verified',
};

export function VerificationsView() {
  const navigate = useNavigate();
  const [items, setItems] = useState<PortalVerificationItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Open-from-item dialog state.
  const [pending, setPending] = useState<PortalVerificationItem | null>(null);
  const [statement, setStatement] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await portalApi.getVerifications();
      setItems(res.verifications);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'Failed to load your verified identity.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openDialog = useCallback((item: PortalVerificationItem) => {
    setError(null);
    setStatement('');
    setPending(item);
  }, []);

  const confirmDispute = useCallback(async () => {
    if (pending === null) return;
    setBusy(true);
    setError(null);
    // A fresh Idempotency-Key per submit (the contract requires a UUID).
    const key = crypto.randomUUID();
    try {
      await portalApi.openDispute(pending.item_id, statement.trim(), key);
      setPending(null);
      navigate('/disputes');
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : 'Your dispute could not be opened.',
      );
    } finally {
      setBusy(false);
    }
  }, [pending, statement, navigate]);

  return (
    <div className="po-page">
      <div className="po-page__head">
        <h1 className="po-page__title">Your verified identity on Aramo</h1>
      </div>
      <p className="po-page__lede">
        What Aramo has verified about you. If something looks wrong, you can
        dispute it — a person reviews every dispute.
      </p>
      {error !== null && <InlineAlert variant="error">{error}</InlineAlert>}

      <Card title="Verified identity">
        <dl className="po-facts">
          {(items ?? []).map((item) => (
            <div key={item.item_id} className="po-consent-row">
              <dt>{KIND_LABELS[item.kind] ?? item.kind}</dt>
              <dd>
                <span className="po-verification-status">
                  {STATUS_LABELS[item.status] ?? item.status}
                </span>
                {item.verified_at !== null && (
                  <span className="po-consent-expiry">
                    {' '}
                    since {fmtDate(item.verified_at)}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openDialog(item)}
                >
                  Dispute this
                </Button>
              </dd>
            </div>
          ))}
        </dl>
        {items !== null && items.length === 0 && (
          <p className="po-page__lede">
            {loading
              ? 'Loading…'
              : 'Aramo has not verified anything about you yet.'}
          </p>
        )}
      </Card>

      <Dialog
        open={pending !== null}
        onOpenChange={(o) => {
          if (!o && !busy) setPending(null);
        }}
        title="Dispute this"
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setPending(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void confirmDispute()}
              disabled={busy || statement.trim() === ''}
            >
              Open dispute
            </Button>
          </>
        }
      >
        <p>
          Tell us what is wrong with this{' '}
          {pending ? (KIND_LABELS[pending.kind] ?? pending.kind).toLowerCase() : 'item'}.
          A person will review it.
        </p>
        <textarea
          className="po-textarea"
          rows={4}
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
          placeholder="What is wrong?"
          aria-label="What is wrong?"
          maxLength={4000}
        />
      </Dialog>
    </div>
  );
}
