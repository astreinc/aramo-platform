import { useState } from 'react';
import { Button, FormField, InlineAlert } from '@aramo/fe-foundation';

import type { EngagementEventView, RecordResponseRequest } from './types';

interface ResponseLoggerProps {
  // RULING 3: the prior outreach_sent events — the response answers one of
  // these (a SENT outreach, not a draft). Presented as a PICKER, not
  // free-form.
  readonly outreachSentEvents: readonly EngagementEventView[];
  readonly onSubmit: (body: RecordResponseRequest) => Promise<void>;
}

// datetime-local → ISO-8601 (the BE @IsDateString wants a full ISO string).
function toIso(localValue: string): string | null {
  if (localValue === '') return null;
  const d = new Date(localValue);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// The response logger (§5). RULING 3: outreach_event_ref_id is chosen from
// a picker of prior outreach_sent events — NOT a free-form id.
// recorded_by_user_id is server-derived (NOT collected here).
export function ResponseLogger({
  outreachSentEvents,
  onSubmit,
}: ResponseLoggerProps) {
  const [refId, setRefId] = useState('');
  const [receivedAt, setReceivedAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (outreachSentEvents.length === 0) {
    return (
      <p>A response can be recorded once an outreach has been sent.</p>
    );
  }

  const submit = async () => {
    const iso = toIso(receivedAt);
    if (refId === '' || iso === null) {
      setError('Select the outreach and the date the response arrived.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        outreach_event_ref_id: refId,
        response_received_at: iso,
      });
      setRefId('');
      setReceivedAt('');
      setSubmitting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed.');
      setSubmitting(false);
    }
  };

  return (
    <form
      className="engagement-response"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <FormField label="Which outreach is this a response to?">
        <select
          value={refId}
          onChange={(e) => setRefId(e.target.value)}
          disabled={submitting}
        >
          <option value="">Select an outreach…</option>
          {outreachSentEvents.map((event) => (
            <option key={event.id} value={event.id}>
              Outreach sent · {event.created_at}
            </option>
          ))}
        </select>
      </FormField>
      <FormField label="When did the response arrive?">
        <input
          type="datetime-local"
          value={receivedAt}
          onChange={(e) => setReceivedAt(e.target.value)}
          disabled={submitting}
        />
      </FormField>
      {error !== null ? (
        <InlineAlert variant="error">{error}</InlineAlert>
      ) : null}
      <Button type="submit" variant="primary" size="sm" disabled={submitting}>
        {submitting ? 'Recording…' : 'Record response'}
      </Button>
    </form>
  );
}
