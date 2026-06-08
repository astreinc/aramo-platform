import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { InlineAlert, PageHeader } from '@aramo/fe-foundation';

import { getCompany } from '../companies/companies-api';
import {
  detailErrorMessage as companyDetailErrorMessage,
} from '../companies/error-messages';
import type { CompanyView, ContactView } from '../companies/types';

import { ContactForm } from './ContactForm';
import { createContact } from './contacts-api';
import { createErrorMessage } from './error-messages';
import type { CreateContactRequest } from './types';

// R6' — the contact CREATE route wrapper.
//
// Route: /companies/:companyId/contacts/new — company_id is REQUIRED
// for every contact, and the URL encodes it (cleaner than a query
// param; back-arrow returns to the company detail). The pre-fetch
// verifies the company exists + is visible (D4b — 404 surfaces a
// friendly error before the form mounts).
//
// On success, navigates to the company detail's Contacts tab (the
// natural return point). The R3 CompanyDetailView re-fetches contacts
// on mount, so the new contact shows up automatically.

export function ContactCreateView() {
  const { companyId } = useParams<{ companyId: string }>();
  const navigate = useNavigate();

  const [company, setCompany] = useState<CompanyView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (companyId === undefined) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getCompany(companyId)
      .then((res) => {
        if (cancelled) return;
        setCompany(res);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(companyDetailErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  if (companyId === undefined) {
    return (
      <InlineAlert variant="error">Missing company id in URL.</InlineAlert>
    );
  }
  if (loading) return <p>Loading company…</p>;
  if (error !== null) {
    return (
      <section>
        <PageHeader title="New contact" />
        <InlineAlert variant="error">{error}</InlineAlert>
        <p>
          <Link to="/companies">← Back to companies</Link>
        </p>
      </section>
    );
  }
  if (company === null) return null;

  async function onSubmit(body: CreateContactRequest): Promise<void> {
    if (company === null) return;
    setSubmitting(true);
    setSubmitError(null);
    let created: ContactView;
    try {
      created = await createContact(body);
    } catch (err) {
      setSubmitError(createErrorMessage(err));
      setSubmitting(false);
      return;
    }
    // Optional log to satisfy the unused-var rule on `created` while
    // keeping the variable around for future toast/breadcrumb logic.
    void created;
    navigate(`/companies/${company.id}`);
  }

  function onCancel(): void {
    navigate(`/companies/${company?.id ?? ''}`);
  }

  return (
    <section>
      <PageHeader
        title={`New contact at ${company.name}`}
        description="Add a person at this company. You can edit details or mark them as having left later."
      />
      <ContactForm
        mode="create"
        companyId={company.id}
        onSubmit={onSubmit}
        onCancel={onCancel}
        submitting={submitting}
        submitError={submitError}
      />
    </section>
  );
}
