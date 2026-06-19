import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  InlineAlert,
  PageHeader,
  hasScope,
  useSession,
} from '@aramo/fe-foundation';

import { CompanyForm } from './CompanyForm';
import { getCompany, updateCompany } from './companies-api';
import { detailErrorMessage, updateErrorMessage } from './error-messages';
import type { CompanyView, UpdateCompanyRequest } from './types';

// R6' — the company EDIT route wrapper. Pre-fetches the existing
// company (the R3 detail's GET), then hands it to CompanyForm which
// builds the PATCH body with true PATCH semantics (R4 omit-vs-null).
//
// D4b visibility: GET /v1/companies/:id 404s on a non-visible company
// → we surface a friendly message + back-link; the form never mounts.

export function CompanyEditView() {
  const { companyId } = useParams<{ companyId: string }>();
  const navigate = useNavigate();
  const sessionState = useSession();
  const canSeeCommercial =
    sessionState.status === 'authenticated' &&
    hasScope(sessionState.session, 'company:read_commercial');

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
        setError(detailErrorMessage(err));
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
        <PageHeader title="Edit company" />
        <InlineAlert variant="error">{error}</InlineAlert>
        <p>
          <Link to="/companies">← Back to companies</Link>
        </p>
      </section>
    );
  }
  if (company === null) return null;

  async function onSubmit(body: UpdateCompanyRequest): Promise<void> {
    if (company === null) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const updated = await updateCompany(company.id, body);
      navigate(`/companies/${updated.id}`);
    } catch (err) {
      setSubmitError(updateErrorMessage(err));
      setSubmitting(false);
    }
  }

  function onCancel(): void {
    navigate(`/companies/${company?.id ?? ''}`);
  }

  return (
    <section>
      <PageHeader
        title={`Edit: ${company.name}`}
        description="Changes apply on save. Leaving a nullable field empty clears it."
      />
      <CompanyForm
        mode="edit"
        initial={company}
        onSubmit={onSubmit}
        onCancel={onCancel}
        submitting={submitting}
        submitError={submitError}
        canSeeCommercial={canSeeCommercial}
      />
    </section>
  );
}
