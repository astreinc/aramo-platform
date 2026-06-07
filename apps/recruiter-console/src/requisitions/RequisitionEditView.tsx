import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  InlineAlert,
  PageHeader,
  useSession,
  type Session,
} from '@aramo/fe-foundation';

import { RequisitionForm } from './RequisitionForm';
import { getRequisition } from './requisitions-api';
import { detailErrorMessage } from './error-messages';
import type { RequisitionView } from './types';

// R4 — the EDIT route wrapper. Pre-fetches the existing requisition
// (the R3 detail's GET), then hands it to RequisitionForm which builds
// the PATCH body with true PATCH semantics + D5-defensive omit.

interface RequisitionEditViewProps {
  readonly sessionOverride?: Session;
}

export function RequisitionEditView({ sessionOverride }: RequisitionEditViewProps) {
  const { reqId } = useParams<{ reqId: string }>();
  const navigate = useNavigate();
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);

  const [req, setReq] = useState<RequisitionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (reqId === undefined) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getRequisition(reqId)
      .then((res) => {
        if (cancelled) return;
        setReq(res);
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
  }, [reqId]);

  if (reqId === undefined) {
    return (
      <InlineAlert variant="error">Missing requisition id in URL.</InlineAlert>
    );
  }
  if (loading) return <p>Loading requisition…</p>;
  if (error !== null) {
    return (
      <section>
        <PageHeader title="Edit requisition" />
        <InlineAlert variant="error">{error}</InlineAlert>
        <p>
          <Link to="/requisitions">← Back to requisitions</Link>
        </p>
      </section>
    );
  }
  if (req === null || session === null) return null;

  function onSuccess(updated: RequisitionView): void {
    navigate(`/requisitions/${updated.id}`);
  }

  function onCancel(): void {
    navigate(`/requisitions/${req?.id ?? ''}`);
  }

  return (
    <section>
      <PageHeader
        title={`Edit: ${req.title}`}
        description="Changes apply on save. Leaving a nullable field empty clears it."
      />
      <p className="req-form__note">
        Compensation fields appear only where you have permission to view
        them. Fields you can't see are not sent on save (so editing a
        requisition you can't see pay for will not blank that data).
      </p>
      <RequisitionForm
        mode="edit"
        session={session}
        initial={req}
        onSuccess={onSuccess}
        onCancel={onCancel}
      />
    </section>
  );
}
