import type { Session } from '@aramo/fe-foundation';

import { NewRequisitionView } from './NewRequisitionView';

// The /requisitions/new route. Rebuilt to mockup parity (charter §7.3): the
// experience now lives in NewRequisitionView (the AI intake lane + the
// grouped edit form + the right rail + the run-match seam). This wrapper is
// kept as the route element + the test seam.

interface RequisitionCreateViewProps {
  readonly sessionOverride?: Session;
}

export function RequisitionCreateView({
  sessionOverride,
}: RequisitionCreateViewProps) {
  return <NewRequisitionView sessionOverride={sessionOverride} />;
}
