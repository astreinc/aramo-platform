import { ApiError } from '@aramo/fe-foundation';
import { describe, expect, it } from 'vitest';

import type { ContactView } from '../companies/types';

import {
  EMPTY_FACETS,
  buildContactQuery,
  contactDisplayName,
  segmentCountFrom,
} from './contact-workspace';
import { contactLinkErrorMessage } from './error-messages';

// CONTACTS-1 — the query builder (?q=, ?deleted=true), the "(Deleted)" display
// name, and the shared contact-link refusal copy.

const base = { scope: 'all', segment: 'all', mode: 'directory', facets: EMPTY_FACETS } as const;

function contact(over: Partial<ContactView> = {}): ContactView {
  return {
    id: 'ct-1', tenant_id: 't', site_id: null,
    first_name: 'Dana', last_name: 'Okafor', title: null,
    email1: null, email2: null, phone_work: null, phone_cell: null, phone_other: null,
    address: null, company_id: 'co-1', company_department_id: null,
    is_hot: false, notes: null, left_company: false, is_primary: false,
    reports_to_id: null, owner_id: null, entered_by_id: null,
    created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
    relationship_role: null, preference: null, last_activity_at: null,
    company_name: null, relationship_types: [],
    deleted_at: null, deleted_by_id: null, contact_kind: null,
    ...over,
  };
}

describe('buildContactQuery — CONTACTS-1', () => {
  it('sends trimmed search text as q alongside paged=true', () => {
    const p = buildContactQuery({ ...base, q: '  dana ' });
    expect(p.get('paged')).toBe('true');
    expect(p.get('q')).toBe('dana');
  });

  it('omits q when the search text is blank', () => {
    expect(buildContactQuery({ ...base, q: '   ' }).has('q')).toBe(false);
    expect(buildContactQuery(base).has('q')).toBe(false);
  });

  it('the deleted segment sends deleted=true (and only then)', () => {
    expect(buildContactQuery({ ...base, segment: 'deleted' }).get('deleted')).toBe('true');
    expect(buildContactQuery({ ...base, segment: 'former' }).has('deleted')).toBe(false);
    expect(buildContactQuery({ ...base, segment: 'former' }).get('former')).toBe('true');
  });

  it('the deleted segment has no facet badge', () => {
    const facets = {
      relationship_role: [], preference: [], company: [],
      hot: 0, quiet: 0, former: 0, primary: 0,
    };
    expect(segmentCountFrom(facets, 3, 'deleted')).toBeNull();
  });
});

describe('contactDisplayName', () => {
  it('marks a deleted contact', () => {
    expect(contactDisplayName(contact())).toBe('Dana Okafor');
    expect(contactDisplayName(contact({ deleted_at: '2026-11-01T00:00:00Z' }))).toBe(
      'Dana Okafor (Deleted)',
    );
  });
});

describe('contactLinkErrorMessage', () => {
  it('maps CONTACT_DELETED', () => {
    const e = new ApiError(422, 'x', 'CONTACT_DELETED', { field: 'contact_id', contact_id: 'c' });
    expect(contactLinkErrorMessage(e)).toMatch(/has been deleted/);
  });

  it('maps the VALIDATION_ERROR contact reasons', () => {
    const v = (reason: string) => new ApiError(422, 'x', 'VALIDATION_ERROR', { reason });
    expect(contactLinkErrorMessage(v('contact_company_mismatch'))).toMatch(/different company/);
    expect(contactLinkErrorMessage(v('contact_not_found'))).toMatch(/could not be found/);
    expect(contactLinkErrorMessage(v('owner_not_assignable'))).toMatch(/owner can’t be assigned/);
  });

  it('returns null for anything else', () => {
    expect(contactLinkErrorMessage(new ApiError(422, 'x', 'VALIDATION_ERROR', { reason: 'other' }))).toBeNull();
    expect(contactLinkErrorMessage(new ApiError(403, 'x'))).toBeNull();
    expect(contactLinkErrorMessage(new Error('x'))).toBeNull();
  });
});
