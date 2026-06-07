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

interface LogNoteDialogProps {
  readonly requisitionId: string;
  readonly onSaved?: () => void;
}

export function LogNoteDialog({ requisitionId, onSaved }: LogNoteDialogProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const reset = () => {
    setText('');
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
        description="A note recorded against this requisition."
        footer={
          <>
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
        <FormField label="Note">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            disabled={submitting}
          />
        </FormField>
        {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      </Dialog>
    </>
  );
}
