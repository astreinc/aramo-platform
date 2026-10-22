import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { stubFetch } from '../tests/fetch-stub';

import { areaOf, splitChange } from './areas';
import { AuditPage } from './AuditPage';
import { EVENT_TYPE_OPTIONS } from './event-labels';
import type { AuditEventView } from './types';

// ORG-UX-1 §8.10 / handoff §6.10 — Org Audit.

function evt(id: string, event_type: string, category: AuditEventView['category'], detail: string, who = 'Olive Owner'): AuditEventView {
  return { id, event_type, category, actor: { id: 'u1', type: 'user', display: who }, subject_id: 's', detail, created_at: '2026-10-21T14:05:00.000Z' };
}

const PAGE1 = {
  items: [
    evt('e1', 'identity.tenant_profile.updated', 'setting', 'Updated tenant profile: legal_name'),
    evt('e2', 'identity.tenant_setting.updated', 'setting', 'Set locale to en-US'),
    evt('e3', 'identity.site.created', 'org', 'Created a branch (site)', 'Sam Site'),
    evt('e4', 'identity.team.created', 'org', 'Created a team'),
    evt('e5', 'identity.domain.claim.authoritative', 'domain', 'Confirmed the organization email domain'),
    evt('e6', 'identity.document_template.adopted', 'template', 'Adopted an Aramo starting point as a document template draft'),
    evt('e7', 'identity.session.issued', 'session', 'Signed in'),
  ],
  next_cursor: 'c2',
};
const PAGE2 = { items: [evt('e8', 'identity.tenant_user.role_assigned', 'access', 'Assigned role(s): recruiter', 'Rae Admin')], next_cursor: null };

describe('Org audit areas', () => {
  it.each([
    ['user', 'identity.invitation.created', 'People'],
    ['user', 'identity.tenant_user.invitation_resent', 'People'],
    ['access', 'identity.tenant_user.role_assigned', 'Access'],
    ['setting', 'identity.tenant_profile.updated', 'Profile'],
    ['setting', 'identity.tenant_setting.updated', 'Settings'],
    ['org', 'identity.site.updated', 'Sites'],
    ['org', 'identity.team.membership.added', 'People'],
    ['org', 'identity.management_edge.set', 'People'],
    ['domain', 'identity.domain.verification.delegation.issued', 'Domain'],
    ['template', 'identity.document_template.version_activated', 'Templates'],
    ['session', 'identity.session.issued', null],
  ] as const)('%s / %s → %s', (category, event_type, area) => {
    expect(areaOf({ category, event_type })).toBe(area);
  });

  it('splits "{action} target" at the first ": "', () => {
    expect(splitChange('Updated tenant profile: legal_name')).toEqual({ action: 'Updated tenant profile', target: 'legal_name' });
    expect(splitChange('Created a team')).toEqual({ action: 'Created a team', target: null });
  });

  it('labels every P3 domain event, the template governance events and the invitation events', () => {
    const values = new Set(EVENT_TYPE_OPTIONS.map((o) => o.value));
    for (const t of [
      'identity.domain.claim.provisional',
      'identity.domain.claim.authoritative',
      'identity.domain.claim.lapsed',
      'identity.domain.claim.released',
      'identity.domain.exception.granted',
      'identity.domain.exception.revoked',
      'identity.domain.verification.delegation.issued',
      'identity.domain.verification.delegation.used',
      'identity.domain.verification.delegation.revoked',
      'identity.document_template.adopted',
      'identity.document_template.created',
      'identity.document_template.version_activated',
      'identity.document_template.selection_set',
      'identity.document_template.selection_cleared',
      'identity.tenant_user.invitation_resent',
      'identity.tenant_user.invitation_revoked',
      'identity.tenant_user.email_changed',
    ]) {
      expect(values.has(t), t).toBe(true);
    }
  });
});

describe('AuditPage', () => {
  function stub() {
    return stubFetch(({ url }) => {
      if (url.startsWith('/v1/tenant/audit-events')) return { body: url.includes('cursor=c2') ? PAGE2 : PAGE1 };
      return undefined;
    });
  }

  it('renders When · Who · Change · Area, hides sign-in sessions, and keyset-pages with Load more', async () => {
    const calls = stub();
    render(<AuditPage />);
    expect(await screen.findByText('Confirmed the organization email domain')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['When', 'Who', 'Change', 'Area']);
    expect(screen.getAllByTestId('audit-row')).toHaveLength(6);
    expect(screen.queryByText('Signed in')).toBeNull();
    expect(screen.getByText('Organization changes only · each app keeps its own audit')).toBeInTheDocument();
    // "{action} *target*"
    expect(screen.getByText('legal_name')).toHaveClass('ox-muted');

    fireEvent.click(screen.getByTestId('audit-load-more'));
    expect(await screen.findByText('Rae Admin')).toBeInTheDocument();
    expect(screen.getAllByTestId('audit-row')).toHaveLength(7);
    expect(calls.some((c) => c.url.includes('cursor=c2'))).toBe(true);
    await waitFor(() => expect(screen.queryByTestId('audit-load-more')).toBeNull());
  });

  it('filters by Area mapped from category + event_type', async () => {
    stub();
    render(<AuditPage />);
    await screen.findByText('Confirmed the organization email domain');
    fireEvent.change(screen.getByTestId('audit-area'), { target: { value: 'Profile' } });
    expect(screen.getAllByTestId('audit-row')).toHaveLength(1);
    expect(screen.getByText('legal_name')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('audit-area'), { target: { value: 'Sites' } });
    expect(screen.getAllByTestId('audit-row')).toHaveLength(1);
    expect(screen.getByText('Sam Site')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('audit-area'), { target: { value: 'People' } });
    expect(screen.getByText('Created a team')).toBeInTheDocument();
  });

  it('searches the loaded pages client-side (person or change) and shows the empty state', async () => {
    const calls = stub();
    render(<AuditPage />);
    await screen.findByText('Confirmed the organization email domain');
    const before = calls.length;
    fireEvent.change(screen.getByTestId('audit-search'), { target: { value: 'sam' } });
    expect(screen.getAllByTestId('audit-row')).toHaveLength(1);
    fireEvent.change(screen.getByTestId('audit-search'), { target: { value: 'adopted' } });
    expect(screen.getAllByTestId('audit-row')).toHaveLength(1);
    fireEvent.change(screen.getByTestId('audit-search'), { target: { value: 'zzz-nothing' } });
    expect(screen.queryAllByTestId('audit-row')).toHaveLength(0);
    expect(screen.getByTestId('audit-empty')).toHaveTextContent('No changes match.');
    expect(calls.length).toBe(before);
  });
});
