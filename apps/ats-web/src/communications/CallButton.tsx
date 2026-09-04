import { useEffect, useState } from 'react';
import { hasScope, type Session } from '@aramo/fe-foundation';

import type { TalentRecordView } from '../talent/types';

import { getCommunicationCapabilities, getMyCommunicationProviderIdentity } from './communications-api';
import { CallDrawer } from './CallDrawer';
import type { ZoomEmbedLoader } from './ZoomPhoneEmbed';
import { COMMUNICATION_VOICE_CALL_SCOPE, type CallRegardingContext, type CommunicationCapabilities, type CommunicationProviderIdentity } from './types';

// COMM-B4 — the recruiter Call affordance for the Talent full-profile header.
// Least-visibility (directive B4 rulings): with NO communication:voice:call scope
// it renders nothing AND makes no communications fetch. With the scope, a GET
// /capabilities call is the runtime provider gate — 200 enables the Call button;
// 409 COMMUNICATION_PROVIDER_NOT_CONFIGURED (or any error) renders Call
// UNAVAILABLE without exposing provider-admin detail to the recruiter. The FE has
// no `ats`-capability primitive and no feature flag — the backend routes remain
// authoritative; the FE gates on scope + the capabilities signal only.

type CapState = { kind: 'loading' } | { kind: 'available' } | { kind: 'unavailable' };

export interface CallButtonProps {
  readonly talent: TalentRecordView;
  readonly session: Session | null;
  /**
   * Explicit voice-call authority. When provided it overrides the session-scope
   * check — used by the requisition drawer, which holds a scopes[] (not a Session).
   */
  readonly canCall?: boolean;
  /** Talent × Requisition (+ pipeline) context when launched from the requisition drawer. */
  readonly regarding?: CallRegardingContext;
  /** Fired after a call is placed / disposition recorded, so the owner can refetch. */
  readonly onCompleted?: () => void;
  /** Injected for tests; default to the real clients. */
  readonly capabilitiesFn?: () => Promise<CommunicationCapabilities>;
  readonly providerIdentityFn?: () => Promise<CommunicationProviderIdentity>;
  readonly embedLoader?: ZoomEmbedLoader;
}

export function CallButton({
  talent,
  session,
  canCall,
  regarding,
  onCompleted,
  capabilitiesFn = getCommunicationCapabilities,
  providerIdentityFn = getMyCommunicationProviderIdentity,
  embedLoader,
}: CallButtonProps) {
  const gated = canCall ?? (session !== null && hasScope(session, COMMUNICATION_VOICE_CALL_SCOPE));
  const [cap, setCap] = useState<CapState>({ kind: 'loading' });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!gated) return;
    let cancelled = false;
    capabilitiesFn()
      .then(() => {
        if (!cancelled) setCap({ kind: 'available' });
      })
      .catch(() => {
        // Neutral: a 409 (not configured) and any other failure both collapse to
        // "unavailable" — the recruiter is never shown provider-admin detail.
        if (!cancelled) setCap({ kind: 'unavailable' });
      });
    return () => {
      cancelled = true;
    };
  }, [gated, capabilitiesFn]);

  // Least-visibility: no scope → no control, no fetch.
  if (!gated) return null;

  if (cap.kind === 'available') {
    return (
      <>
        <button type="button" className="rc-comm-call" onClick={() => setOpen(true)}>
          Call
        </button>
        {open ? (
          <CallDrawer
            talent={talent}
            onClose={() => setOpen(false)}
            {...(regarding !== undefined ? { regarding } : {})}
            {...(onCompleted !== undefined ? { onCompleted } : {})}
            providerIdentityFn={providerIdentityFn}
            embedLoader={embedLoader}
          />
        ) : null}
      </>
    );
  }

  return (
    <button
      type="button"
      className="rc-comm-call"
      disabled
      title={cap.kind === 'loading' ? 'Checking calling availability…' : 'Calling isn’t available'}
      aria-busy={cap.kind === 'loading'}
    >
      Call
    </button>
  );
}
