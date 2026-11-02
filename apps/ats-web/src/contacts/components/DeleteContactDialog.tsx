import { useState } from 'react';
import { DialogClose } from '@aramo/fe-foundation';

import { Button, Dialog, InlineAlert } from '../../ui';
import { deleteContact } from '../contacts-api';
import { deleteErrorMessage } from '../error-messages';

// CONTACTS-1 FE-SD-1 — the confirmation step behind every contact delete icon
// (row, card, drawer). The delete is a SOFT delete (DELETE /v1/contacts/:id →
// 204): the contact leaves every list and picker, existing links keep it, and
// a contact:delete holder can restore it from the Deleted view.

export interface DeleteContactDialogProps {
  readonly contactId: string;
  readonly contactName: string;
  readonly onCancel: () => void;
  readonly onDeleted: () => void;
}

export function DeleteContactDialog({
  contactId,
  contactName,
  onCancel,
  onDeleted,
}: DeleteContactDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteContact(contactId);
      onDeleted();
    } catch (err) {
      setError(deleteErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
      title={`Delete ${contactName}?`}
      description="The contact is removed from the directory and from contact pickers. Requisitions, tasks and lists that already reference it keep the link and show it as deleted. An admin can restore it from the Deleted view."
      size="sm"
      footer={
        <div className="sw-modal__footer">
          <DialogClose asChild>
            <Button variant="ghost" type="button" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            data-testid="contact-delete-confirm"
          >
            {busy ? 'Deleting…' : 'Delete contact'}
          </Button>
        </div>
      }
    >
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
    </Dialog>
  );
}
