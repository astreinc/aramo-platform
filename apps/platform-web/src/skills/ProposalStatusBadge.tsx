import type { ProposalStatus } from './skills-api';

// SKILL-TAX-1F-C2 — proposal lifecycle state marker (PENDING / ACCEPTED / REJECTED).
export function ProposalStatusBadge({ status }: { readonly status: ProposalStatus | string }) {
  return (
    <span className="pw-proposal-badge" data-status={status} aria-label={`Status: ${status}`}>
      {status}
    </span>
  );
}
