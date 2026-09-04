import { useEffect, useState } from 'react';
import { ApiError } from '@aramo/fe-foundation';

import { safeErrorMessage } from '../ui';
import type { TalentRecordView } from '../talent/types';

import {
  getMyCommunicationProviderIdentity,
  initiateCommunicationCall,
  recordCommunicationDisposition,
  type InitiateCallInput,
} from './communications-api';
import { ZoomPhoneEmbed, type ZoomEmbedLoader } from './ZoomPhoneEmbed';
import {
  COMMUNICATION_DISPOSITION_OUTCOMES,
  type CallRegardingContext,
  type CommunicationDispositionOutcome,
  type CommunicationInteractionView,
  type CommunicationProviderIdentity,
} from './types';

// COMM-C2A — the recruiter Call drawer, now WIRED to the delivered backend call
// route (POST /v1/communications/calls) and the append-only disposition surface.
// Consent + provider config remain backend-authoritative: a refusal surfaces as
// safe copy, never provider-admin detail. When launched from a Requisition Talent
// context the `regarding` (requisition + pipeline) is supplied, so a successful
// first attempt can drive the governed no_contact→contacted transition server-side.
// No Zoom vocabulary lives here — it is confined to ZoomPhoneEmbed.

interface PhoneOption {
  readonly key: 'cell' | 'work' | 'home';
  readonly label: string;
  readonly number: string;
}

function phoneOptions(t: TalentRecordView): PhoneOption[] {
  return [
    { key: 'cell' as const, label: 'Mobile', number: t.phone_cell },
    { key: 'work' as const, label: 'Work', number: t.phone_work },
    { key: 'home' as const, label: 'Home', number: t.phone_home },
  ].filter((o): o is PhoneOption => o.number !== null && o.number.length > 0);
}

const DISPOSITION_LABELS: Record<CommunicationDispositionOutcome, string> = {
  connected: 'Connected — spoke with talent',
  interested: 'Interested',
  callback_requested: 'Callback requested',
  follow_up_required: 'Follow-up required',
  left_voicemail: 'Left voicemail',
  no_answer: 'No answer',
  busy: 'Busy',
  wrong_number: 'Wrong number',
  not_interested: 'Not interested',
  do_not_contact: 'Do not contact',
};

type IdentityState =
  | { kind: 'loading' }
  | { kind: 'ready'; identity: CommunicationProviderIdentity }
  | { kind: 'not_mapped' }
  | { kind: 'error' };

export interface CallDrawerProps {
  readonly talent: TalentRecordView;
  readonly onClose: () => void;
  /** Talent × Requisition (+ pipeline) context when launched from the requisition drawer. */
  readonly regarding?: CallRegardingContext;
  /** Fired after a call is placed and/or a disposition recorded, so the owner can refetch. */
  readonly onCompleted?: () => void;
  /** Injected for tests; default to the real clients. */
  readonly providerIdentityFn?: () => Promise<CommunicationProviderIdentity>;
  readonly initiateFn?: typeof initiateCommunicationCall;
  readonly dispositionFn?: typeof recordCommunicationDisposition;
  readonly embedLoader?: ZoomEmbedLoader;
}

export function CallDrawer({
  talent,
  onClose,
  regarding,
  onCompleted,
  providerIdentityFn = getMyCommunicationProviderIdentity,
  initiateFn = initiateCommunicationCall,
  dispositionFn = recordCommunicationDisposition,
  embedLoader,
}: CallDrawerProps) {
  const options = phoneOptions(talent);
  const [selected, setSelected] = useState<PhoneOption['key'] | null>(options[0]?.key ?? null);
  const [identity, setIdentity] = useState<IdentityState>({ kind: 'loading' });

  // Call lifecycle: idle → placing → placed (interaction recorded) → done.
  const [interaction, setInteraction] = useState<CommunicationInteractionView | null>(null);
  const [placing, setPlacing] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);

  // Disposition capture (post-call).
  const [disposition, setDisposition] = useState<CommunicationDispositionOutcome | ''>('');
  const [notes, setNotes] = useState('');
  const [savingDisp, setSavingDisp] = useState(false);
  const [dispError, setDispError] = useState<string | null>(null);
  const [dispDone, setDispDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    providerIdentityFn()
      .then((id) => {
        if (!cancelled) setIdentity({ kind: 'ready', identity: id });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setIdentity({ kind: 'not_mapped' });
        } else {
          setIdentity({ kind: 'error' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [providerIdentityFn]);

  const callerReady = identity.kind === 'ready';
  const canPlace = callerReady && selected !== null && !placing && interaction === null;

  const placeCall = async (): Promise<void> => {
    if (!canPlace || selected === null) return;
    setPlacing(true);
    setCallError(null);
    try {
      const input: InitiateCallInput = {
        talent_id: talent.id,
        phone_slot: selected,
        ...(regarding !== undefined
          ? { regarding: { requisition_id: regarding.requisition_id, pipeline_id: regarding.pipeline_id } }
          : {}),
      };
      const view = await initiateFn(input);
      setInteraction(view);
      // A successful attempt may have advanced the pipeline (no_contact→contacted).
      onCompleted?.();
    } catch (err) {
      setCallError(safeErrorMessage(err, 'Could not place the call. Try again.'));
    } finally {
      setPlacing(false);
    }
  };

  const saveDisposition = async (): Promise<void> => {
    if (interaction === null || disposition === '' || savingDisp) return;
    setSavingDisp(true);
    setDispError(null);
    try {
      await dispositionFn(interaction.id, {
        disposition,
        ...(notes.trim() !== '' ? { notes: notes.trim() } : {}),
      });
      setDispDone(true);
      onCompleted?.();
    } catch (err) {
      setDispError(safeErrorMessage(err, 'Could not save the outcome. Try again.'));
    } finally {
      setSavingDisp(false);
    }
  };

  return (
    <aside className="rc-comm-drawer" role="dialog" aria-label={`Call ${talent.first_name} ${talent.last_name}`}>
      <header className="rc-comm-drawer__hd">
        <h2 className="rc-comm-drawer__title">Call {talent.first_name} {talent.last_name}</h2>
        <button type="button" className="rc-comm-drawer__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <fieldset className="rc-comm-drawer__section">
        <legend>Number</legend>
        {options.length === 0 ? (
          <p className="rc-comm-drawer__empty">No phone number on file for this talent.</p>
        ) : (
          options.map((o) => (
            <label key={o.key} className="rc-comm-drawer__radio">
              <input
                type="radio"
                name="rc-comm-phone"
                value={o.key}
                checked={selected === o.key}
                disabled={interaction !== null}
                onChange={() => setSelected(o.key)}
              />
              {o.label} · {o.number}
            </label>
          ))
        )}
      </fieldset>

      <section className="rc-comm-drawer__section">
        <h3 className="rc-comm-drawer__subhd">Calling as</h3>
        {identity.kind === 'loading' ? (
          <p className="rc-comm-drawer__muted">Loading…</p>
        ) : identity.kind === 'ready' ? (
          <p className="rc-comm-drawer__caller">
            {identity.identity.display_phone_number ??
              identity.identity.extension ??
              identity.identity.provider_user_id}
          </p>
        ) : identity.kind === 'not_mapped' ? (
          <p className="rc-comm-drawer__muted">
            Calling is unavailable because your account isn’t mapped to a phone provider yet.
            Ask a tenant administrator to set up your mapping.
          </p>
        ) : (
          <p className="rc-comm-drawer__muted">Couldn’t load your calling identity.</p>
        )}
      </section>

      <section className="rc-comm-drawer__section">
        <h3 className="rc-comm-drawer__subhd">Regarding</h3>
        <p className="rc-comm-drawer__muted">
          {regarding !== undefined ? 'This requisition' : 'General talent contact'}
        </p>
      </section>

      <ZoomPhoneEmbed loader={embedLoader} />

      {/* ── Disposition capture (post-call, append-only; existing taxonomy) ── */}
      {interaction !== null ? (
        <section className="rc-comm-drawer__section" data-testid="call-disposition">
          <h3 className="rc-comm-drawer__subhd">Outcome</h3>
          {dispDone ? (
            <p className="rc-comm-drawer__caller" data-testid="disposition-saved">Outcome recorded.</p>
          ) : (
            <>
              <label className="rc-comm-drawer__radio">
                Disposition
                <select
                  className="rc-input"
                  value={disposition}
                  data-testid="disposition-select"
                  onChange={(e) => setDisposition(e.target.value as CommunicationDispositionOutcome | '')}
                >
                  <option value="">— Select outcome —</option>
                  {COMMUNICATION_DISPOSITION_OUTCOMES.map((o) => (
                    <option key={o} value={o}>
                      {DISPOSITION_LABELS[o]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="rc-comm-drawer__radio">
                Notes (optional)
                <textarea
                  className="rc-input"
                  value={notes}
                  data-testid="disposition-notes"
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                />
              </label>
              {dispError !== null ? <p className="rc-comm-drawer__muted">{dispError}</p> : null}
              <button
                type="button"
                className="rc-comm-drawer__call"
                disabled={disposition === '' || savingDisp}
                data-testid="disposition-submit"
                onClick={() => void saveDisposition()}
              >
                {savingDisp ? 'Saving…' : 'Record outcome'}
              </button>
            </>
          )}
        </section>
      ) : null}

      <footer className="rc-comm-drawer__ft">
        {interaction === null ? (
          <>
            <button
              type="button"
              className="rc-comm-drawer__call"
              disabled={!canPlace}
              data-testid="call-submit"
              onClick={() => void placeCall()}
            >
              {placing ? 'Calling…' : 'Call'}
            </button>
            <p className="rc-comm-drawer__note">
              {callError !== null
                ? callError
                : callerReady && selected !== null
                  ? 'Places a call and records it as engagement evidence.'
                  : 'Select a number and confirm your calling identity to place a call.'}
            </p>
          </>
        ) : (
          <p className="rc-comm-drawer__note" data-testid="call-placed">
            Call recorded. Add the outcome above, then close.
          </p>
        )}
      </footer>
    </aside>
  );
}
