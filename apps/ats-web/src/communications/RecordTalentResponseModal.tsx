import { useMemo, useRef, useState } from 'react';
import { ApiError, Button, Dialog, InlineAlert, Input, TextArea, useToast } from '@aramo/fe-foundation';

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
  onRecorded,
  onClose,
}: RecordTalentResponseModalProps) {
  const now = useMemo(() => new Date(), []);
  const [channel, setChannel] = useState<TalentResponseChannelChoice | null>(null);
  const [date, setDate] = useState(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
  const [time, setTime] = useState(`${pad(now.getHours())}:${pad(now.getMinutes())}`);
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  // Exactly one of: null | 'failed' (generic/5xx) | 'stale' (409 journey moved).
  const [banner, setBanner] = useState<null | 'failed' | 'stale'>(null);
  const [serverDateErr, setServerDateErr] = useState<string | null>(null);
  // One idempotency key per modal instance — reused across retries so "Try again"
  // after a transient failure dedupes rather than double-records (§8 / watch-item #3).
  const idempotencyKey = useRef<string>(crypto.randomUUID());
  const toast = useToast();

  const occurredAtLocal = `${date}T${time}`;

  const clientErrors = (): { channel?: boolean; date?: string; note?: boolean } => {
    const e: { channel?: boolean; date?: string; note?: boolean } = {};
    if (channel === null) e.channel = true;
    if (date === '' || time === '') e.date = 'Enter the date and time they responded.';
    else if (new Date(occurredAtLocal).getTime() > Date.now()) e.date = 'Response time can’t be in the future.';
    else if (firstContactAtIso !== undefined && new Date(occurredAtLocal).getTime() < new Date(firstContactAtIso).getTime())
      e.date = `Must be after first contact${firstContactLabel === undefined ? '' : ` (${firstContactLabel})`}.`;
    if (channel === 'other' && note.trim() === '') e.note = true;
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
    setServerDateErr(null);
    try {
      const result = await recordTalentResponse(
        {
          pipeline_id: pipelineId,
          channel,
          occurred_at: new Date(occurredAtLocal).toISOString(),
          ...(note.trim() === '' ? {} : { note: note.trim() }),
        },
        idempotencyKey.current,
      );
      toast.show(`Response recorded · ${talentName} is now Talent responded`);
      onRecorded(result);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // §10 — the journey changed while recording. Closing refetches the latest.
        setBanner('stale');
      } else if (err instanceof ApiError && err.status === 400) {
        // Field-level validation echoed inline (occurred_at is the only guarded field).
        setServerDateErr(typeof err.message === 'string' ? err.message : 'That value was rejected.');
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
            <span style={{ fontWeight: 500, color: '#93A0A8' }}>{channel === 'other' ? '· required for Other' : '· optional'}</span>
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

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11.5, color: '#5C6770', lineHeight: 1.5, borderTop: '1px solid #F2F4F6', paddingTop: 11 }}>
          <span>
            Saved as your attested account of the response, recorded by you and logged to the audit trail. The journey moves to
            Talent responded once it’s saved.
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
