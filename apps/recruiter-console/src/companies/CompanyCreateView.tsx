import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  InlineAlert,
  PageHeader,
  hasScope,
  useSession,
} from '@aramo/fe-foundation';

import { CompanyForm } from './CompanyForm';
import { createCompany } from './companies-api';
import { createErrorMessage } from './error-messages';
import type { CompanyView, CreateCompanyRequest } from './types';

// R6' — the company CREATE route wrapper. Thin adapter: pulls the
// session/cancel target, navigates to the new company's detail on
// success, and surfaces submit errors.

export function CompanyCreateView() {
  const navigate = useNavigate();
  const sessionState = useSession();
  const canSeeCommercial =
    sessionState.status === 'authenticated' &&
    hasScope(sessionState.session, 'company:read_commercial');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function onSubmit(body: CreateCompanyRequest): Promise<void> {
    setSubmitting(true);
    setSubmitError(null);
    let created: CompanyView;
    try {
      created = await createCompany(body);
    } catch (err) {
      setSubmitError(createErrorMessage(err));
      setSubmitting(false);
      return;
    }
    navigate(`/companies/${created.id}`);
  }

  function onCancel(): void {
    navigate('/companies');
  }

  return (
    <section>
      <PageHeader
        title="New company"
        description="Add a client to your tenant. You can add contacts and assign work after saving."
      />
      <p className="company-form__note">
        You'll be able to set a billing contact and add contacts once the
        company exists.
      </p>
      {submitError !== null ? (
        <InlineAlert variant="error">{submitError}</InlineAlert>
      ) : null}
      <CompanyForm
        mode="create"
        onSubmit={onSubmit}
        onCancel={onCancel}
        submitting={submitting}
        submitError={submitError}
        canSeeCommercial={canSeeCommercial}
      />
    </section>
  );
}
