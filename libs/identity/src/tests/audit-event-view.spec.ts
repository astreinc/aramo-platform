import { describe, expect, it } from 'vitest';

import {
  categoryOf,
  summarizeDetail,
} from '../lib/audit/audit-event.view.js';
import { EVENT_TYPES } from '../lib/audit/identity-audit.repository.js';

// Settings Rebuild D2 — the readable + redacted detail summarizer.

const ALL_SCOPES = ['compensation:view:bill'];
const NO_FINANCIAL = ['talent:read'];

describe('audit detail — readable + redacted', () => {
  it('renders a human sentence for every event type (never raw JSON)', () => {
    for (const et of EVENT_TYPES) {
      const detail = summarizeDetail(et, {}, ALL_SCOPES);
      expect(detail.length).toBeGreaterThan(0);
      expect(detail).not.toContain('{');
      expect(detail).not.toContain('"');
    }
  });

  // IC-1 PR-1 Gate-5 G5-08 — the cross-tenant refusal detail is a FIXED sentence:
  // even if a payload ever carried foreign identifiers, the whitelist never
  // echoes them to the tenant-visible detail.
  it('identity.invitation.rejected_cross_tenant renders a fixed sentence and echoes NO payload field', () => {
    const foreignUser = '01900000-0000-7000-8000-0000000000c1';
    const foreignTenant = '01900000-0000-7000-8000-0000000000b2';
    const detail = summarizeDetail(
      'identity.invitation.rejected_cross_tenant',
      {
        reason: 'existing_user_owned_by_other_tenant',
        tier: 'tenant',
        attempted_tenant_id: '01900000-0000-7000-8000-0000000000b1',
        request_id: 'rq-1',
        existing_user_id: foreignUser,
        existing_membership_tenant_ids: [foreignTenant],
        email: 'owned@elsewhere.io',
      },
      ALL_SCOPES,
    );
    expect(detail).toBe('Refused an invitation — the email is already registered to another tenant');
    expect(detail).not.toContain(foreignUser);
    expect(detail).not.toContain(foreignTenant);
    expect(detail).not.toContain('owned@elsewhere.io');
    expect(detail).not.toContain('rq-1');
    expect(categoryOf('identity.invitation.rejected_cross_tenant')).toBe('user');
  });

  it('summarizes a setting change with before/after for a permitted viewer', () => {
    const detail = summarizeDetail(
      'identity.tenant_setting.updated',
      { key: 'compensation.display_default', value: 'both', previous_value: 'spread' },
      ALL_SCOPES,
    );
    expect(detail).toBe('Changed compensation.display_default from spread to both');
  });

  it('REDACTS financial setting values from a viewer without the gating scope', () => {
    const detail = summarizeDetail(
      'identity.tenant_setting.updated',
      { key: 'audit.financials_enabled', value: true, previous_value: false },
      NO_FINANCIAL,
    );
    expect(detail).toContain('values hidden');
    expect(detail).not.toContain('true');
    expect(detail).not.toContain('false');
    expect(detail).not.toContain('on');
    expect(detail).not.toContain('off');
  });

  it('renders role-assign deltas from the whitelisted role_keys field only', () => {
    const detail = summarizeDetail(
      'identity.tenant_user.role_assigned',
      { role_keys: ['recruiter', 'sourcer'], secret: 'should-never-show' },
      ALL_SCOPES,
    );
    expect(detail).toBe('Assigned role(s): recruiter, sourcer');
    expect(detail).not.toContain('secret');
    expect(detail).not.toContain('should-never-show');
  });

  it('categorizes events for the FE pill', () => {
    expect(categoryOf('identity.tenant_setting.updated')).toBe('setting');
    expect(categoryOf('identity.session.issued')).toBe('session');
    expect(categoryOf('identity.tenant_user.role_assigned')).toBe('access');
    expect(categoryOf('identity.team.created')).toBe('org');
    expect(categoryOf('identity.tenant_user.disabled')).toBe('user');
    expect(categoryOf('identity.tenant.created')).toBe('system');
  });
});
