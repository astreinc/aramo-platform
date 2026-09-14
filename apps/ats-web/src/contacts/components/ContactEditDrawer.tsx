import { useEffect, useRef, useState } from 'react';
import { InlineAlert } from '@aramo/fe-foundation';

import type { ContactView } from '../../companies/types';
import { Icons } from '../../ui';
import { createContact, updateContact } from '../contacts-api';
import { createErrorMessage, updateErrorMessage } from '../error-messages';
import { FULL_NAME } from '../contact-workspace';
import type {
  CreateContactRequest,
  UpdateContactRequest,
} from '../types';

import { ContactQuickEditForm } from './ContactQuickEditForm';

// Contacts prototype parity — the right slide-over quick-edit is the ONLY
// contact surface. Create and edit share this one panel (the prototype's
// create/edit drawer), mirroring CompanyEditDrawer. There is no standalone
// contact detail/edit page: the row click and the company-detail deep-link
// (/contacts?edit=<id>) both open this drawer.

interface ContactEditDrawerProps {
  readonly mode: 'create' | 'edit';
  readonly contact: ContactView | null; // required for edit
  // Create context — pre-selects the company (the company-detail "Add contact"
  // affordance carries the company through). Ignored on edit.
  readonly initialCompanyId?: string;
  readonly onClose: () => void;
  readonly onSaved: (contact: ContactView) => void;
}

export function ContactEditDrawer({
  mode,
  contact,
  initialCompanyId,
  onClose,
  onSaved,
}: ContactEditDrawerProps) {
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const asideRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const open = mode === 'create' || contact !== null;

  // a11y: capture trigger, focus the heading on open, restore focus on close.
  useEffect(() => {
    if (!open) return;
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.focus();
    const toRestore = restoreRef.current;
    return () => toRestore?.focus();
  }, [open]);

  // Esc closes; Tab is trapped within the drawer (dialog semantics).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = asideRef.current;
      if (root === null) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function onCreate(body: CreateContactRequest): Promise<void> {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await createContact(body);
      onSaved(created);
    } catch (err) {
      setSubmitError(createErrorMessage(err));
      setSubmitting(false);
    }
  }

  async function onUpdate(body: UpdateContactRequest): Promise<void> {
    if (contact === null) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const updated = await updateContact(contact.id, body);
      onSaved(updated);
    } catch (err) {
      setSubmitError(updateErrorMessage(err));
      setSubmitting(false);
    }
  }

  const title =
    mode === 'edit' && contact !== null ? FULL_NAME(contact) : 'New contact';

  return (
    <aside
      ref={asideRef}
      className="rc-drawer rc-drawer--open rc-drawer--edit"
      role="dialog"
      aria-modal="false"
      aria-label={mode === 'edit' ? `Edit ${title}` : 'New contact'}
      data-testid="contact-edit-drawer"
    >
      <div className="rc-drawer__hd">
        <h3 ref={headingRef} tabIndex={-1} className="rc-drawer__title">
          {title}
          {mode === 'edit' ? (
            <span className="rc-drawer__badge" data-testid="contact-edit-badge">
              EDITING
            </span>
          ) : null}
        </h3>
        <button
          type="button"
          className="rc-drawer__x"
          aria-label="Close"
          onClick={onClose}
        >
          <Icons.IconX />
        </button>
      </div>

      <div className="rc-drawer__body">
        {submitError !== null ? (
          <InlineAlert variant="error">{submitError}</InlineAlert>
        ) : null}
        {mode === 'edit' && contact !== null ? (
          <ContactQuickEditForm
            mode="edit"
            initial={contact}
            onSubmit={onUpdate}
            onCancel={onClose}
            submitting={submitting}
          />
        ) : (
          <ContactQuickEditForm
            mode="create"
            initialCompanyId={initialCompanyId}
            onSubmit={onCreate}
            onCancel={onClose}
            submitting={submitting}
          />
        )}
      </div>
    </aside>
  );
}
