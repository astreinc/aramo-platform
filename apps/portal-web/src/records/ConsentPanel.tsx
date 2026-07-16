import { useCallback, useEffect, useState } from 'react';
import { ApiError, Button, Card, Dialog, InlineAlert } from '@aramo/fe-foundation';

import {
  portalApi,
  type ConsentScope,
  type ConsentScopeState,
  type ConsentScopeStatus,
  type ConsentHistoryEvent,
  type PortalConsentText,
} from '../portal-api';

// Portal P2 P2b (§PR-2) — the per-record consent management panel. Rendered
// inside RecordDetailView for a record reachable through the caller's chain.
//
// - Current state per scope, derived HONESTLY (active / expired / revoked / not
//   granted) — no fabricated "active" for an expired or never-granted scope.
// - Grant flow renders the EXACT versioned consent text the backend hashes (the
//   D7 preimage), fetched from /consent/text so the displayed bytes ARE the
//   preimage. The recipient tenant is named in chrome (tenantName); a per-submit
//   Idempotency-Key (UUID) rides the contract.
// - Revoke flow confirms, then reflects the new state immediately (refetch).
// - Append-only history list (engagement-class event fields only).
//
// No trust UI, no origin fields — this is an engagement surface (P-R5).

const SCOPE_LABELS: Record<ConsentScope, string> = {
  profile_storage: 'Store my profile',
  resume_processing: 'Process my résumé',
  matching: 'Match me to opportunities',
  contacting: 'Contact me about opportunities',
  cross_tenant_visibility: 'Share my profile beyond this organization',
};

const STATUS_LABELS: Record<ConsentScopeStatus, string> = {
  granted: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
  no_grant: 'Not granted',
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

type Pending = { scope: ConsentScope; action: 'grant' | 'revoke' } | null;

export function ConsentPanel({
  recordId,
  tenantName,
}: {
  recordId: string;
  tenantName: string | null;
}) {
  const [scopes, setScopes] = useState<ConsentScopeState[] | null>(null);
  const [history, setHistory] = useState<ConsentHistoryEvent[] | null>(null);
  const [text, setText] = useState<PortalConsentText | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);

  // The engagement counterparty, named for chrome; falls back to a neutral
  // phrase (never a raw id) if the name is missing.
  const recipient = tenantName ?? 'this organization';

  const load = useCallback(async () => {
    setError(null);
    try {
      const [state, hist] = await Promise.all([
        portalApi.getRecordConsent(recordId),
        portalApi.getConsentHistory(recordId),
      ]);
      setScopes(state.scopes);
      setHistory(hist.events);
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : 'Failed to load your consent state.',
      );
    }
  }, [recordId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Opening a grant needs the exact text; fetch it lazily on first open.
  const openGrant = useCallback(
    async (scope: ConsentScope) => {
      setError(null);
      if (text === null) {
        try {
          setText(await portalApi.getConsentText(recordId));
        } catch (e) {
          setError(
            e instanceof ApiError
              ? e.message
              : 'Failed to load the consent text.',
          );
          return;
        }
      }
      setPending({ scope, action: 'grant' });
    },
    [recordId, text],
  );

  const confirm = useCallback(async () => {
    if (pending === null) return;
    setBusy(true);
    setError(null);
    // A fresh Idempotency-Key per submit (the contract requires a UUID).
    const key = crypto.randomUUID();
    try {
      if (pending.action === 'grant') {
        const version = text?.version ?? '';
        await portalApi.grantConsent(recordId, pending.scope, version, key);
      } else {
        await portalApi.revokeConsent(recordId, pending.scope, key);
      }
      setPending(null);
      await load(); // immediate state reflection
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : 'Your change could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }, [pending, recordId, text, load]);

  const pendingText =
    pending?.action === 'grant'
      ? text?.texts.find((t) => t.scope === pending.scope)?.text ?? ''
      : '';

  return (
    <Card
      title="Consent"
      description={`What ${recipient} may do with your information. You control each item and can change it at any time.`}
    >
      {error !== null && <InlineAlert variant="error">{error}</InlineAlert>}

      <dl className="po-facts">
        {(scopes ?? []).map((s) => {
          const active = s.status === 'granted';
          return (
            <div key={s.scope} className="po-consent-row">
              <dt>{SCOPE_LABELS[s.scope]}</dt>
              <dd>
                <span className={`po-consent-status po-consent-status--${s.status}`}>
                  {STATUS_LABELS[s.status]}
                </span>
                {active && s.expires_at !== null && (
                  <span className="po-consent-expiry">
                    {' '}
                    until {fmtDate(s.expires_at)}
                  </span>
                )}
                {active ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPending({ scope: s.scope, action: 'revoke' })}
                  >
                    Revoke
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void openGrant(s.scope)}
                  >
                    Grant
                  </Button>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {scopes !== null && scopes.length === 0 && (
        <p className="po-page__lede">No consent scopes to manage.</p>
      )}

      {/* History — append-only, engagement-class fields only. */}
      <h2 className="po-consent-history__title">History</h2>
      {history !== null && history.length === 0 ? (
        <p className="po-page__lede">No consent changes yet.</p>
      ) : (
        <ul className="po-consent-history">
          {(history ?? []).map((h) => (
            <li key={h.event_id}>
              <span className="po-consent-history__action">{h.action}</span>{' '}
              {SCOPE_LABELS[h.scope]}{' '}
              <span className="po-consent-history__when">
                {fmtDate(h.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={pending !== null}
        onOpenChange={(o) => {
          if (!o && !busy) setPending(null);
        }}
        title={
          pending?.action === 'grant'
            ? `Grant consent to ${recipient}`
            : `Revoke consent`
        }
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
              variant={pending?.action === 'grant' ? 'primary' : 'secondary'}
              onClick={() => void confirm()}
              disabled={busy}
            >
              {pending?.action === 'grant' ? 'I agree' : 'Revoke'}
            </Button>
          </>
        }
      >
        {pending?.action === 'grant' ? (
          <p className="po-consent-text">{pendingText}</p>
        ) : (
          <p>
            You are revoking “{pending ? SCOPE_LABELS[pending.scope] : ''}”. This
            takes effect immediately.
          </p>
        )}
      </Dialog>
    </Card>
  );
}
