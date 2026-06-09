import { useState } from 'react';
import { Button, FormField, InlineAlert } from '@aramo/fe-foundation';

import type { RecordConversationRequest } from './types';

interface ConversationLoggerProps {
  readonly onSubmit: (body: RecordConversationRequest) => Promise<void>;
}

function toIso(localValue: string): string | null {
  if (localValue === '') return null;
  const d = new Date(localValue);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// The conversation logger (§5) — a single conversation_started_at field.
// recorded_by_user_id is server-derived (NOT collected here).
export function ConversationLogger({ onSubmit }: ConversationLoggerProps) {
  const [startedAt, setStartedAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const iso = toIso(startedAt);
    if (iso === null) {
      setError('Select when the conversation began.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ conversation_started_at: iso });
      setStartedAt('');
      setSubmitting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed.');
      setSubmitting(false);
    }
  };

  return (
    <form
      className="engagement-conversation"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <FormField label="When did the conversation begin?">
        <input
          type="datetime-local"
          value={startedAt}
          onChange={(e) => setStartedAt(e.target.value)}
          disabled={submitting}
        />
      </FormField>
      {error !== null ? (
        <InlineAlert variant="error">{error}</InlineAlert>
      ) : null}
      <Button type="submit" variant="primary" size="sm" disabled={submitting}>
        {submitting ? 'Recording…' : 'Record conversation'}
      </Button>
    </form>
  );
}
