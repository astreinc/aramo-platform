import { useState } from 'react';
import {
  Button,
  Dialog,
  FormField,
  InlineAlert,
  useToast,
} from '@aramo/fe-foundation';

import { createNote } from './activity-api';
import { noteErrorMessage } from './error-messages';
import {
  NOTE_BODY_MAX_LENGTH,
  NOTE_CATEGORY_LABELS,
  NOTE_CATEGORY_VALUES,
  NOTE_VISIBILITY_LABELS,
  NOTE_VISIBILITY_VALUES,
  type NoteCategory,
  type NoteVisibility,
} from './types';

interface LogNoteDialogProps {
  readonly requisitionId: string;
  // Subject-confirmation line (D-4 / AC-9) — prevents logging on the wrong
  // record. Optional so existing callers keep compiling; when present the
  // dialog shows "Recorded against <code> · <title>".
  readonly requisitionCode?: string;
  readonly requisitionTitle?: string;
  readonly onSaved?: () => void;
}

const NOTE_PLACEHOLDER =
  'Capture decisions, client feedback, requirement changes, risks, or next steps…';

export function LogNoteDialog({
  requisitionId,
  requisitionCode,
  requisitionTitle,
  onSaved,
}: LogNoteDialogProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [category, setCategory] = useState<NoteCategory>('GENERAL');
  const [visibility, setVisibility] = useState<NoteVisibility>('TEAM');
  const [pinned, setPinned] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const reset = () => {
    setText('');
    setCategory('GENERAL');
    setVisibility('TEAM');
    setPinned(false);
    setError(null);
    setSubmitting(false);
  };

  const submit = async () => {
    if (text.trim() === '') {
      setError('Please enter the note before saving.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createNote({
        type: 'note',
        subject_type: 'requisition',
        subject_id: requisitionId,
        notes: text.trim(),
        category,
        visibility,
        pinned,
      });
      toast.show('Note logged.');
      setOpen(false);
      reset();
      onSaved?.();
    } catch (err) {
      setError(noteErrorMessage(err));
      setSubmitting(false);
    }
  };

  const subjectLine =
    requisitionCode !== undefined || requisitionTitle !== undefined
      ? `Recorded against ${[requisitionCode, requisitionTitle]
          .filter((s): s is string => s !== undefined && s !== '')
          .join(' · ')}`
      : 'A note recorded against this requisition.';

  const remaining = NOTE_BODY_MAX_LENGTH - text.length;

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        Log note
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        title="Log a note"
        description={subjectLine}
        footer={
          <>
            <label className="lognote__pin">
              <input
                type="checkbox"
                checked={pinned}
                onChange={(e) => setPinned(e.target.checked)}
                disabled={submitting}
              />
              Pin to overview
            </label>
            <Button
              variant="secondary"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              disabled={submitting}
            >
              {submitting ? 'Saving…' : 'Save note'}
            </Button>
          </>
        }
      >
        <FormField label="Category">
          <div className="lognote__category" role="group" aria-label="Category">
            {NOTE_CATEGORY_VALUES.map((c) => (
              <button
                key={c}
                type="button"
                className="lognote__category-chip"
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
                disabled={submitting}
              >
                {NOTE_CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
        </FormField>
        <FormField label="Visibility">
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as NoteVisibility)}
            disabled={submitting}
          >
            {NOTE_VISIBILITY_VALUES.map((v) => (
              <option key={v} value={v}>
                {NOTE_VISIBILITY_LABELS[v]}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Note">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            maxLength={NOTE_BODY_MAX_LENGTH}
            placeholder={NOTE_PLACEHOLDER}
            style={{ resize: 'vertical', minHeight: '220px' }}
            disabled={submitting}
          />
          <div className="lognote__meta">
            <span className="lognote__hint">
              Timestamped and attributed to you
            </span>
            <span className="lognote__count">
              {remaining.toLocaleString()} characters left
            </span>
          </div>
        </FormField>
        {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      </Dialog>
    </>
  );
}
