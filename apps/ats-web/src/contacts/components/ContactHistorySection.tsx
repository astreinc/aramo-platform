import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  FormField,
  InlineAlert,
  Select,
  TextArea,
  hasScope,
  useSession,
} from '@aramo/fe-foundation';

import { formatInstant } from '../../format/date';
import { isRedacted, redactedNoteLabel } from '../../activity/redaction';
import { NOTE_BODY_MAX_LENGTH, type ActivityView } from '../../activity/types';
import { resolveUserNames } from '../../users/users-api';
import {
  CONTACT_HISTORY_KINDS,
  CONTACT_HISTORY_KIND_LABELS,
  contactHistoryLoadErrorMessage,
  contactHistoryRecordErrorMessage,
  listContactHistory,
  recordContactActivity,
  type ContactHistoryKind,
} from '../contact-history-api';

// CONTACTS-1 §8 — the contact drawer's history section (H-3). Read-only list of
// the notes, calls and emails recorded against the contact (type, summary,
// actor, time), newest first, scoped server-side to the actor's visibility.
// An actor holding activity:create may record a new entry; the server refuses
// a deleted contact (H-4) and moves last_activity_at forward on success (H-2).

const TYPE_LABELS: Readonly<Record<ActivityView['type'], string>> = {
  note: 'Note',
  call: 'Call',
  email_logged: 'Email',
  pipeline_status_change: 'Stage change',
};

export function ContactHistorySection({ contactId }: { contactId: string }) {
  const sessionState = useSession();
  const session = sessionState.status === 'authenticated' ? sessionState.session : null;
  const canRecord =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'activity:create');

  const [items, setItems] = useState<readonly ActivityView[]>([]);
  const [userNames, setUserNames] = useState<Readonly<Record<string, string>>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [kind, setKind] = useState<ContactHistoryKind>('note');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await listContactHistory(contactId);
      const sorted = [...res.items].sort((a, b) => b.created_at.localeCompare(a.created_at));
      setItems(sorted);
      const ids = sorted
        .map((a) => a.created_by_id)
        .filter((id): id is string => id !== null);
      // Best-effort: unresolved authors are simply omitted.
      setUserNames(await resolveUserNames(ids));
    } catch (err) {
      setLoadError(contactHistoryLoadErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    void load();
  }, [load]);

  const trimmed = text.trim();

  async function submit() {
    if (trimmed === '' || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await recordContactActivity(contactId, { type: kind, notes: trimmed });
      setText('');
      await load();
    } catch (err) {
      setSaveError(contactHistoryRecordErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rc-drawer__sec" aria-label="Activity history" data-testid="contact-history">
      <h4>Activity history</h4>

      {canRecord ? (
        <div data-testid="contact-history-add">
          <FormField label="Type">
            <Select
              value={kind}
              onChange={(e) => setKind(e.target.value as ContactHistoryKind)}
              aria-label="Activity type"
            >
              {CONTACT_HISTORY_KINDS.map((k) => (
                <option key={k} value={k}>{CONTACT_HISTORY_KIND_LABELS[k]}</option>
              ))}
            </Select>
          </FormField>
          <FormField label="Details">
            <TextArea
              rows={2}
              value={text}
              maxLength={NOTE_BODY_MAX_LENGTH}
              onChange={(e) => setText(e.target.value)}
              placeholder="What happened?"
              aria-label="Activity details"
            />
          </FormField>
          {saveError !== null ? <InlineAlert variant="error">{saveError}</InlineAlert> : null}
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={trimmed === '' || saving}
          >
            {saving ? 'Saving…' : `Add ${CONTACT_HISTORY_KIND_LABELS[kind].toLowerCase()}`}
          </Button>
        </div>
      ) : null}

      <div className={canRecord ? 'rc-mt-16' : undefined}>
        {loading ? (
          <p className="rc-empty">Loading history…</p>
        ) : loadError !== null ? (
          <InlineAlert variant="error">{loadError}</InlineAlert>
        ) : items.length === 0 ? (
          <p className="rc-empty">No activity recorded for this contact yet.</p>
        ) : (
          <ul className="rc-detail-list rc-detail-list--flush">
            {items.map((a) => {
              const actor =
                a.created_by_id !== null ? (userNames[a.created_by_id] ?? null) : null;
              const summary = isRedacted(a)
                ? redactedNoteLabel(a.redacted_at, null)
                : (a.notes?.trim() ?? '');
              return (
                <li
                  key={a.id}
                  className="rc-tmrow rc-tmrow--row"
                  data-testid={`contact-history-${a.id}`}
                >
                  <div className="rc-tmrow__body">
                    <div className="rc-tmrow__nm">{TYPE_LABELS[a.type]}</div>
                    {summary !== '' ? <div className="rc-tmrow__rl">{summary}</div> : null}
                    <div className="rc-tmrow__rl">
                      {actor !== null ? <span>{actor} · </span> : null}
                      <time dateTime={a.created_at}>{formatInstant(a.created_at)}</time>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
