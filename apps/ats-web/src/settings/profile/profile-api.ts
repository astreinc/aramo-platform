// Settings Rebuild Directive 3 — tenant-profile read/write client.
//
//   GET   /v1/tenant/profile  -> TenantProfileView
//   PATCH /v1/tenant/profile  (partial) -> TenantProfileView
//
// Gates on tenant:admin:settings (reused — same scope as the registry).

import { apiClient } from '@aramo/fe-foundation';

export const PROFILE_PATH = '/v1/tenant/profile';

// Hand-mirror of libs/identity TenantProfileView (leaf consumer of the HTTP
// surface — the no-@aramo/* import rule).
export interface TenantProfileView {
  readonly id: string;
  readonly name: string;
  readonly legal_name: string | null;
  readonly display_name: string | null;
  readonly address_line1: string | null;
  readonly address_line2: string | null;
  readonly city: string | null;
  readonly state_province: string | null;
  readonly postal_code: string | null;
  readonly country_code: string | null;
  readonly tax_id: string | null;
  readonly registration_number: string | null;
  readonly primary_contact_name: string | null;
  readonly primary_contact_email: string | null;
  readonly primary_contact_phone: string | null;
  readonly logo_url: string | null;
  readonly updated_at: string;
}

// The editable fields (excludes id / name / updated_at).
export const EDITABLE_PROFILE_FIELDS = [
  'legal_name',
  'display_name',
  'address_line1',
  'address_line2',
  'city',
  'state_province',
  'postal_code',
  'country_code',
  'tax_id',
  'registration_number',
  'primary_contact_name',
  'primary_contact_email',
  'primary_contact_phone',
  'logo_url',
] as const;

export type EditableProfileField = (typeof EDITABLE_PROFILE_FIELDS)[number];

export type ProfilePatch = Partial<Record<EditableProfileField, string>>;

export function fetchTenantProfile(): Promise<TenantProfileView> {
  return apiClient.get<TenantProfileView>(PROFILE_PATH);
}

export function updateTenantProfile(patch: ProfilePatch): Promise<TenantProfileView> {
  return apiClient.patch<TenantProfileView>(PROFILE_PATH, patch);
}
