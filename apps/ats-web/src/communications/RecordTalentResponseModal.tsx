import { useMemo, useRef, useState } from 'react';
import { ApiError, Button, Dialog, InlineAlert, Input, TextArea, useToast } from '@aramo/fe-foundation';

import { formatInstant } from '../format/date';
import { AttestCheckbox } from '../ui/AttestCheckbox';

import {
  recordTalentResponse,
  type RecordTalentResponseResult,
  type TalentResponseChannelChoice,
} from './talent-response-api';

// Recruiting-Journey §7/§15 — ONE shared "Record Talent response" modal reused by all
// four Requisition surfaces. It records recruiter-attested response EVIDENCE; it NEVER
// sets Pipeline stage. On success the caller refetches canonical journey state (the
// backend advanced the milestone through evidence authority); the FE forces nothing.

interface ChannelTile {
  readonly value: TalentResponseChannelChoice;
  readonly label: string;
}
const CHANNELS: readonly ChannelTile[] = [
  { value: 'phone', label: 'Phone call' },
  { value: 'email', label: 'Email' },
  { value: 'sms', label: 'SMS / messaging' },
  { value: 'other', label: 'Other' },
];
const NOTE_MAX = 500;

export interface RecordTalentResponseModalProps {
  readonly open: boolean;
  readonly pipelineId: string;
  readonly talentName: string;
  readonly reqCode: string;
  // "contacted Oct 5 by email" — the first-contact context line (optional).
  readonly contactNote?: string;
  // Optional UX floor hint: the first grounded outbound contact. The BACKEND is
  // authoritative (it refuses occurred_at < first contact); this only pre-empts the
  // round-trip for a better message when the instant is known client-side.
  readonly firstContactAtIso?: string;
  readonly firstContactLabel?: string;
  // Talent Lifecycle R1–R5 Impl Directive v1.2 §7.6 (S4) — set when the modal is opened FROM a
  // specific interaction (e.g. the call the Talent answered): it is sent as the confirmation's
  // source, verified server-side, and the note becomes optional. Absent → a note is required.
  readonly sourceInteractionId?: string;
  // Called after the backend recorded evidence + advanced the milestone. The caller
  // closes the surface and refetches the journey from authoritative state.
  readonly onRecorded: (result: RecordTalentResponseResult) => void;
  readonly onClose: () => void;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function RecordTalentResponseModal({
  open,
  pipelineId,
  talentName,
  reqCode,
  contactNote,
  firstContactAtIso,
  firstContactLabel,
  sourceInteractionId,
  onRecorded,
  onClose,
}: RecordTalentResponseModalProps) {
  const now = useMemo(() => new Date(), []);
  const [channel, setChannel] = useState<TalentResponseChannelChoice | null>(null);
  const [date, setDate] = useState(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
  const [time, setTime] = useState(`${pad(now.getHours())}:${pad(now.getMinutes())}`);
  const [note, setNote] = useState('');
  // v1.2 §7.4 — the recruiter's attestation that the Talent gave a substantive response.
  const [attested, setAttested] = useState(false);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  // Exactly one of: null | 'failed' (generic/5xx) | 'stale' (409 journey moved) | a typed refusal.
  const [banner, setBanner] = useState<null | 'failed' | 'stale'>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const noteRequired = sourceInteractionId === undefined || channel === 'other';
  const [serverDateErr, setServerDateErr] = useState<string | null>(null);
  // One idempotency key per modal instance — reused across retries so "Try again"
  // after a transient failure dedupes rather than double-records (§8 / watch-item #3).
  const idempotencyKey = useRef<string>(crypto.randomUUID());
  const toast = useToast();

  const occurredAtLocal = `${date}T${time}`;

  const clientErrors = (): { channel?: boolean; date?: string; note?: boolean; attest?: boolean } => {
    const e: { channel?: boolean; date?: string; note?: boolean; attest?: boolean } = {};
    if (channel === null) e.channel = true;
    if (date === '' || time === '') e.date = 'Enter the date and time they responded.';
    else if (new Date(occurredAtLocal).getTime() > Date.now()) e.date = 'Response time can’t be in the future.';
    else if (firstContactAtIso !== undefined && new Date(occurredAtLocal).getTime() < new Date(firstContactAtIso).getTime())
      e.date = `Must be after first contact${firstContactLabel === undefined ? '' : ` (${firstContactLabel})`}.`;
    if (noteRequired && note.trim() === '') e.note = true;
    if (!attested) e.attest = true;
    return e;
  };

  const submit = async (): Promise<void> => {
    if (saving) return;
    const errs = clientErrors();
    if (Object.keys(errs).length > 0) {
      setTried(true);
      setBanner(null);
      return;
    }
    if (channel === null) return; // narrowed — clientErrors() already requires it
    setSaving(true);
    setBanner(null);
    setRefusal(null);
    setServerDateErr(null);
    try {
      const result = await recordTalentResponse(
        {
          pipeline_id: pipelineId,
          channel,
          occurred_at: new Date(occurredAtLocal).toISOString(),
          substantive_response_attested: true,
          ...(sourceInteractionId === undefined ? {} : { source_interaction_id: sourceInteractionId }),
          ...(note.trim() === '' ? {} : { note: note.trim() }),
        },
        idempotencyKey.current,
      );
      // v1.2 §7.6 — show the reviewer and the time on the recorded response.
      const recordedAt = new Date(result.recorded_at).toLocaleString();
      toast.show(
        result.advanced
          ? `Response recorded by you · ${recordedAt} · ${talentName} is now Talent responded`
          : `Response recorded by you · ${recordedAt} · kept as history — the requisition is closed, so the journey doesn’t move`,
      );
      onRecorded(result);
    } catch (err) {
      const typed = err instanceof ApiError ? talentResponseRefusalMessage(err) : null;
      if (typed !== null) {
        setRefusal(typed);
      } else if (err instanceof ApiError && err.status === 409) {
        // §10 — the journey changed while recording. Closing refetches the latest.
        setBanner('stale');
      } else if (err instanceof ApiError && (err.status === 400 || err.status === 422)) {
        // Field-level validation (400 DTO format) AND the §-rule rejections
        // (422 business rules) shown inline on the guarded field (occurred_at).
        // ATS-QA-1 I-1 D7 — mapped to recruiter copy; the raw server message
        // (which names the wire field) is never echoed.
        setServerDateErr(responseTimeErrorMessage(err));
        setTried(true);
      } else {
        // network / 5xx — values preserved, retryable.
        setBanner('failed');
      }
      setSaving(false);
    }
  };

  const errs = tried ? clientErrors() : {};
  const dateErrText = serverDateErr ?? errs.date ?? null;
  const subtitle = [talentName, reqCode, contactNote].filter((s) => s !== undefined && s !== '').join(' · ');

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
      title="Record Talent response"
      description={subtitle}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {banner === 'failed' ? (
          <InlineAlert variant="error">
            <b>Couldn’t record the response.</b> Nothing was changed. Your entries are kept — try again.
          </InlineAlert>
        ) : null}
        {refusal !== null ? <InlineAlert variant="error">{refusal}</InlineAlert> : null}
        {banner === 'stale' ? (
          <InlineAlert variant="error">
            {talentName}’s journey changed while you were recording. Close to see the latest.
          </InlineAlert>
        ) : null}

        <div>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 7 }}>How did the Talent respond?</div>
          <div role="radiogroup" aria-label="Response channel" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 6 }}>
            {CHANNELS.map((c) => {
              const on = channel === c.value;
              return (
                <Button
                  unstyled
                  key={c.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={saving}
                  onClick={() => {
                    setChannel(c.value);
                    setBanner(null);
                  }}
                  style={{
                    padding: '10px 4px 9px',
                    border: `1.5px solid ${on ? '#022AC0' : errs.channel ? '#E0A89A' : '#D5DBE1'}`,
                    background: on ? '#E8EDFB' : '#fff',
                    color: on ? '#011F8D' : '#1B2730',
                    borderRadius: 9,
                    cursor: saving ? 'default' : 'pointer',
                    font: "600 12px 'Hanken Grotesk',sans-serif",
                    opacity: saving ? 0.6 : 1,
                  }}
                >
                  {c.label}
                </Button>
              );
            })}
          </div>
          {errs.channel ? (
            <div style={{ fontSize: 11.5, color: '#B3402A', fontWeight: 600, marginTop: 6 }}>Choose how the Talent responded.</div>
          ) : null}
        </div>

        <div>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 7 }}>When did they respond?</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr)', gap: 8 }}>
            <Input
              unstyled
              type="date"
              aria-label="Response date"
              value={date}
              disabled={saving}
              onChange={(e) => {
                setDate(e.target.value);
                setBanner(null);
                setServerDateErr(null);
              }}
              style={{ border: `1px solid ${dateErrText ? '#E0A89A' : '#D5DBE1'}`, borderRadius: 8, padding: '8px 10px', boxSizing: 'border-box', width: '100%' }}
            />
            <Input
              unstyled
              type="time"
              aria-label="Response time"
              value={time}
              disabled={saving}
              onChange={(e) => {
                setTime(e.target.value);
                setBanner(null);
                setServerDateErr(null);
              }}
              style={{ border: `1px solid ${dateErrText ? '#E0A89A' : '#D5DBE1'}`, borderRadius: 8, padding: '8px 10px', boxSizing: 'border-box', width: '100%' }}
            />
          </div>
          {dateErrText ? (
            <div style={{ fontSize: 11.5, color: '#B3402A', fontWeight: 600, marginTop: 6 }}>{dateErrText}</div>
          ) : (
            <div style={{ fontSize: 11.5, color: '#93A0A8', marginTop: 6 }}>Defaults to now. Change it if they responded earlier. Your time zone.</div>
          )}
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12, fontWeight: 600, marginBottom: 7 }}>
            Note{' '}
            <span style={{ fontWeight: 500, color: '#93A0A8' }}>
              {channel === 'other' ? '· required for Other' : noteRequired ? '· required' : '· optional'}
            </span>
            <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 500, color: '#93A0A8' }}>{note.length} / {NOTE_MAX}</span>
          </div>
          <TextArea
            rows={3}
            value={note}
            disabled={saving}
            maxLength={NOTE_MAX}
            placeholder={channel === 'other' ? 'How did they respond? e.g. via a direct message or referral' : 'What did they say? e.g. Interested, available after Oct 20'}
            onChange={(e) => {
              setNote(e.target.value);
              setBanner(null);
            }}
          />
          {errs.note ? (
            <div style={{ fontSize: 11.5, color: '#B3402A', fontWeight: 600, marginTop: 4 }}>Add a short note saying how they responded.</div>
          ) : null}
        </div>

        <div>
          <AttestCheckbox
            checked={attested}
            disabled={saving}
            onChange={(v) => {
              setAttested(v);
              setRefusal(null);
            }}
          >
            I confirm the Talent gave a real response about this role (not a voicemail, missed call or a request to call back).
          </AttestCheckbox>
          {errs.attest ? (
            <div style={{ fontSize: 11.5, color: '#B3402A', fontWeight: 600, marginTop: 4 }}>Confirm the Talent gave a real response.</div>
          ) : null}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11.5, color: '#5C6770', lineHeight: 1.5, borderTop: '1px solid #F2F4F6', paddingTop: 11 }}>
          <span>
            Saved as your confirmation of the response, recorded by you with the time it happened and the time you recorded it,
            and logged to the audit trail. The journey moves to Talent responded once it’s saved.
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="secondary" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={saving} aria-busy={saving} onClick={() => void submit()}>
            {saving ? 'Recording…' : banner === 'failed' ? 'Try again' : 'Record response'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// Talent Lifecycle R1–R5 Impl Directive v1.2 §7.4/§7.5 (S4) — the typed refusals get specific copy
// (never the generic "journey changed" banner). Null = not a typed refusal.
export function talentResponseRefusalMessage(err: ApiError): string | null {
  const reason = (err.details as { reason?: unknown } | undefined)?.reason;
  if (err.code === 'PIPELINE_EVIDENCE_INADMISSIBLE') {
    if (reason === 'source_not_substantive') {
      return 'That call or message wasn’t a real response (for example a voicemail or a request to call back), so it can’t be confirmed as one.';
    }
    return 'This response can’t be confirmed from that record. Add a note describing how the Talent responded.';
  }
  if (err.code === 'REQUISITION_NOT_ADVANCEABLE') {
    return 'This requisition is closed or not yet open for responses. A response can only be recorded if it happened before the requisition closed.';
  }
  if (err.code === 'INSUFFICIENT_PERMISSIONS' && reason === 'recruiter_user_required') {
    return 'Only a recruiter can confirm a Talent response.';
  }
  if (err.code === 'TRANSACTION_CONFLICT_RETRYABLE') {
    return 'Something changed at the same moment, so nothing was saved. Try again.';
  }
  return null;
}

// ATS-QA-1 I-1 D7 — recruiter copy for a 400/422 rejection of the response time. The backend
// (talent-response.service.ts) refuses a time before the first grounded contact with
// details { field: 'occurred_at', first_contact_at }, and a future time with { field: 'occurred_at' }.
// The raw server message is never shown.
export function responseTimeErrorMessage(err: ApiError): string {
  const details = (err.details ?? {}) as { field?: unknown; first_contact_at?: unknown };
  if (details.field === 'occurred_at') {
    if (typeof details.first_contact_at === 'string' && details.first_contact_at !== '') {
      return `Response time can’t be earlier than the first recorded contact (${formatInstant(details.first_contact_at)}).`;
    }
    if (typeof err.message === 'string' && /future/i.test(err.message)) {
      return 'Response time can’t be in the future.';
    }
    return 'That response time wasn’t accepted. Check the date and time and try again.';
  }
  return 'Some details weren’t accepted. Check the date and time and try again.';
}
