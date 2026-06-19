import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { InlineAlert, PageHeader } from '@aramo/fe-foundation';

import type { ContactView } from '../companies/types';

import { ContactForm } from './ContactForm';
import { getContact, updateContact } from './contacts-api';
import { detailErrorMessage, updateErrorMessage } from './error-messages';
import type { UpdateContactRequest } from './types';

// R6' — the contact EDIT route wrapper. Pre-fetches the existing
// contact, then hands it to ContactForm which builds the PATCH body
// with true PATCH semantics (R4 omit-vs-null).
//
// On success, navigates back to the contact's company DETAIL (where
// the Contacts tab will re-fetch). EDIT preserves the contact's
// company anchor (the DTO doesn't accept company_id on PATCH — a
// contact can't change companies).

export function ContactEditView() {
  const { contactId } = useParams<{ contactId: string }>();
  const navigate = useNavigate();

  const [contact, setContact] = useState<ContactView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (contactId === undefined) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getContact(contactId)
      .then((res) => {
        if (cancelled) return;
        setContact(res);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(detailErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  if (contactId === undefined) {
    return (
      <InlineAlert variant="error">Missing contact id in URL.</InlineAlert>
    );
  }
  if (loading) return <p>Loading contact…</p>;
  if (error !== null) {
    return (
      <section>
        <PageHeader title="Edit contact" />
        <InlineAlert variant="error">{error}</InlineAlert>
        <p>
          <Link to="/companies">← Back to companies</Link>
        </p>
      </section>
    );
  }
  if (contact === null) return null;

  async function onSubmit(body: UpdateContactRequest): Promise<void> {
    if (contact === null) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await updateContact(contact.id, body);
      navigate(`/companies/${contact.company_id}`);
    } catch (err) {
      setSubmitError(updateErrorMessage(err));
      setSubmitting(false);
    }
  }

  function onCancel(): void {
    if (contact !== null) {
      navigate(`/companies/${contact.company_id}`);
    } else {
      navigate('/companies');
    }
  }

  return (
    <section>
      <PageHeader
        title={`Edit: ${contact.first_name} ${contact.last_name}`.trim()}
        description="Changes apply on save. Leaving a nullable field empty clears it."
      />
      <ContactForm
        mode="edit"
        initial={contact}
        onSubmit={onSubmit}
        onCancel={onCancel}
        submitting={submitting}
        submitError={submitError}
      />
    </section>
  );
}
