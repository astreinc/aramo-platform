import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { InlineAlert } from '@aramo/fe-foundation';

import { Icons } from '../../ui';
import { createCompany, updateCompany } from '../companies-api';
import { createErrorMessage, updateErrorMessage } from '../error-messages';
import type {
  CompanyView,
  CreateCompanyRequest,
  UpdateCompanyRequest,
} from '../types';

import { CompanyQuickEditForm } from './CompanyQuickEditForm';

// Company Party/Role (ADR-0032, R6) — the right slide-over quick-edit. Create
// and edit share this one panel (the prototype's create/edit drawer). Replaces
// the standalone CompanyEditView + CompanyCreateView full pages. The account
// hub (CompanyDetailView) remains the deep view, reached via "Open full record".

interface CompanyEditDrawerProps {
  readonly mode: 'create' | 'edit';
  readonly company: CompanyView | null; // required for edit
  readonly canSeeCommercial: boolean;
  readonly onClose: () => void;
  readonly onSaved: (company: CompanyView) => void;
}

export function CompanyEditDrawer({
  mode,
  company,
  canSeeCommercial,
  onClose,
  onSaved,
}: CompanyEditDrawerProps) {
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const asideRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const open = mode === 'create' || company !== null;

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

  async function onCreate(body: CreateCompanyRequest): Promise<void> {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await createCompany(body);
      onSaved(created);
    } catch (err) {
      setSubmitError(createErrorMessage(err));
      setSubmitting(false);
    }
  }

  async function onUpdate(body: UpdateCompanyRequest): Promise<void> {
    if (company === null) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const updated = await updateCompany(company.id, body);
      onSaved(updated);
    } catch (err) {
      setSubmitError(updateErrorMessage(err));
      setSubmitting(false);
    }
  }

  const title = mode === 'edit' && company !== null ? company.name : 'New company';

  return (
    <aside
      ref={asideRef}
      className="rc-drawer rc-drawer--open rc-drawer--edit"
      role="dialog"
      aria-modal="false"
      aria-label={mode === 'edit' ? `Edit ${title}` : 'New company'}
      data-testid="company-edit-drawer"
    >
      <div className="rc-drawer__hd">
        <h3 ref={headingRef} tabIndex={-1} className="rc-drawer__title">
          {title}
          {mode === 'edit' ? (
            <span className="rc-drawer__badge" data-testid="company-edit-badge">
              EDITING
            </span>
          ) : null}
        </h3>
        {mode === 'edit' && company !== null ? (
          <Link
            to={`/companies/${company.id}`}
            className="rc-drawer__full"
            data-testid="company-open-full-record"
          >
            Open full record →
          </Link>
        ) : null}
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
        {mode === 'edit' && company !== null ? (
          <CompanyQuickEditForm
            mode="edit"
            initial={company}
            onSubmit={onUpdate}
            onCancel={onClose}
            submitting={submitting}
            canSeeCommercial={canSeeCommercial}
          />
        ) : (
          <CompanyQuickEditForm
            mode="create"
            onSubmit={onCreate}
            onCancel={onClose}
            submitting={submitting}
            canSeeCommercial={canSeeCommercial}
          />
        )}
      </div>
    </aside>
  );
}
