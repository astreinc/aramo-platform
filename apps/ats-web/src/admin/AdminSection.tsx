import { PageHeader } from '@aramo/fe-foundation';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Card, CardHead } from '../ui';

// AdminSection — the admin-gated landing (FE Consolidation). Rendered only
// behind <AdminGate> (the `tenant:admin:*` family gate), so by the time this
// mounts the principal is admin-scoped.
//
// As admin modules port in (one directive each), they surface here. Consent is
// the first (Directive 2). Consent has no discovery/list surface yet — it is a
// per-talent route reached by direct URL (PR-9 §4.2) — so the affordance is a
// talent-id lookup that routes to /admin/consent/:talentId. The remaining
// modules are listed as not-yet-ported.

const PENDING_MODULES = [
  'Settings',
  'Users',
  'Organisation',
  'Teams',
  'Assignments',
] as const;

export function AdminSection() {
  const navigate = useNavigate();
  const [talentId, setTalentId] = useState('');
  const trimmed = talentId.trim();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (trimmed === '') return;
    navigate(`/admin/consent/${encodeURIComponent(trimmed)}`);
  };

  return (
    <section className="rc-stack">
      <PageHeader
        title="Administration"
        description="Tenant administration tools."
      />

      <Card>
        <CardHead title="Consent visibility" />
        <p className="rc-muted-line rc-mt-8">
          View a talent's consent state, history, and decision log. Enter a
          talent identifier to open its consent record.
        </p>
        <form className="rc-mt-8 rc-admin-lookup" onSubmit={onSubmit}>
          <input
            className="rc-input"
            aria-label="Talent identifier"
            placeholder="Talent ID"
            value={talentId}
            onChange={(e) => setTalentId(e.target.value)}
            data-testid="admin-consent-talent-id"
          />
          <Button
            type="submit"
            disabled={trimmed === ''}
            data-testid="admin-consent-open"
          >
            View consent
          </Button>
        </form>
      </Card>

      <Card>
        <CardHead title="More admin modules" />
        <p className="rc-muted-line rc-mt-8">
          The following modules are being consolidated into this console and
          will appear here as each is ported:
        </p>
        <ul className="rc-mt-8">
          {PENDING_MODULES.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
