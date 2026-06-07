import { useNavigate } from 'react-router-dom';
import {
  PageHeader,
  useSession,
  type Session,
} from '@aramo/fe-foundation';

import { RequisitionForm } from './RequisitionForm';
import type { RequisitionView } from './types';

// R4 — the CREATE route wrapper. The form does the work; this is a
// thin route adapter that pulls the session, navigates to the new req's
// detail on success, and handles the back-to-list cancel.

interface RequisitionCreateViewProps {
  // Test seam (R3 RouteGuard / DetailView pattern).
  readonly sessionOverride?: Session;
}

export function RequisitionCreateView({ sessionOverride }: RequisitionCreateViewProps) {
  const navigate = useNavigate();
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);

  if (session === null) {
    return null;
  }

  function onSuccess(req: RequisitionView): void {
    navigate(`/requisitions/${req.id}`);
  }

  function onCancel(): void {
    navigate('/requisitions');
  }

  return (
    <section>
      <PageHeader
        title="New requisition"
        description="Create a new job order. You can edit details after saving."
      />
      <p className="req-form__note">
        Compensation fields appear only where you have permission to view
        them. Fields you can't see are not sent on save.
      </p>
      <RequisitionForm
        mode="create"
        session={session}
        onSuccess={onSuccess}
        onCancel={onCancel}
      />
    </section>
  );
}
