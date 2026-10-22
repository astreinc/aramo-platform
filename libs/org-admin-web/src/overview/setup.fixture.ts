import type { DomainVerificationView } from '../domain/domain-api';
import type { TenantProfileView } from '../profile/profile-api';
import type { SiteView } from '../sites/types';
import type { TenantUserView } from '../users/types';

// Test fixtures shared by the Overview / checklist specs.

export function profile(over: Partial<TenantProfileView> = {}): TenantProfileView {
  return {
    id: 't1', name: 'acme', legal_name: null, display_name: null, address_line1: null, address_line2: null, city: null,
    state_province: null, postal_code: null, country_code: null, tax_id: null, registration_number: null,
    primary_contact_name: null, primary_contact_email: null, primary_contact_phone: null, logo_url: null,
    updated_at: '2026-10-01T00:00:00.000Z', ...over,
  };
}
export function domain(over: Partial<DomainVerificationView> = {}): DomainVerificationView {
  return { status: 'UNVERIFIED', allowed_domain: 'acme.test', record_name: null, record_value: null, verified_at: null, token_issued_at: null, ...over };
}
export function user(id: string, over: Partial<TenantUserView> = {}): TenantUserView {
  return { user_id: id, email: `${id}@acme.test`, display_name: id, is_active: true, invite_status: 'ACTIVE', deactivated_at: null, site_id: null, role_keys: [], ...over };
}
export function site(id: string): SiteView {
  return { id, name: id, is_active: true, parent_site_id: null, created_at: '', updated_at: '' };
}
