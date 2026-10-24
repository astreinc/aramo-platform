import { useParams } from 'react-router-dom';
import type { Session } from '@aramo/fe-foundation';

import { ProposalsView } from './ProposalsView';

// PLATFORM-UX-1 F-7 — /skills/proposals/:id: the proposals list with this
// proposal open in the detail pane (handoff §9 Proposals).
export function ProposalDetailView({ session }: { readonly session: Session }) {
  const { id = '' } = useParams();
  return <ProposalsView session={session} selectedId={id} />;
}
