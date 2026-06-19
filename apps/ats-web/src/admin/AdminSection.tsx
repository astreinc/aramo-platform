import { PageHeader } from '@aramo/fe-foundation';

// AdminSection — the admin-gated landing placeholder (FE Consolidation
// Phase 1). This PR establishes the gated home + the role-gating skeleton; the
// real admin modules (settings, users, org, teams, assignments, consent) port
// in here in Phase 2+, each its own PR, each restyled to Confident-Blue.
//
// Rendered only behind <AdminGate> (the `tenant:admin:*` family gate), so by
// the time this mounts the principal is admin-scoped.

export function AdminSection() {
  return (
    <section>
      <PageHeader title="Administration" />
      <p style={{ color: 'var(--c-text-muted)' }}>
        Tenant administration is being consolidated into this console. Settings,
        users, organisation, teams, assignments, and consent will appear here.
      </p>
    </section>
  );
}
