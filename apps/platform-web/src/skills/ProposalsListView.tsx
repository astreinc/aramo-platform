import { ProposalsView } from './ProposalsView';

// PLATFORM-UX-1 F-7 — /skills/proposals: the proposals list; it opens the first
// proposal of the status filter at /skills/proposals/:id (ProposalDetailView),
// where the decision controls are gated on platform:skill:manage.
export function ProposalsListView() {
  return <ProposalsView session={null} selectedId={null} />;
}
