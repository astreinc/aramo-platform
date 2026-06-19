import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';

import {
  TenantRepository,
  type TenantProfileRow,
} from '../tenant.repository.js';

import {
  PROFILE_FIELDS,
  validateProfilePatch,
  type ProfileField,
  type TenantProfileView,
} from './tenant-profile.view.js';

// Settings Rebuild Directive 3 — tenant-profile read/update service.
//
// All operations are on the CALLER's own tenant (tenant_id pinned from the JWT
// at the controller). Validation failures surface as 400; a genuinely missing
// tenant is 404. The audit event is emitted by the controller (the app-layer
// two-call seam) only when a field actually changed (the S2 no-op-no-audit
// precedent).

@Injectable()
export class TenantProfileService {
  constructor(private readonly tenants: TenantRepository) {}

  async getProfile(tenantId: string, requestId: string): Promise<TenantProfileView> {
    const row = await this.tenants.findProfileById(tenantId);
    if (row === null) {
      throw new AramoError('NOT_FOUND', 'Tenant not found', 404, {
        requestId,
        details: { tenant_id: tenantId },
      });
    }
    return toView(row);
  }

  // Validates + applies the patch. Returns the updated view AND the list of
  // fields that ACTUALLY changed (drives the controller's audit emission — an
  // empty list means no-op, no audit).
  async updateProfile(args: {
    tenantId: string;
    body: Record<string, unknown>;
    requestId: string;
  }): Promise<{ view: TenantProfileView; changedFields: ProfileField[] }> {
    const patch = validateProfilePatch(args.body, args.requestId);
    const current = await this.tenants.findProfileById(args.tenantId);
    if (current === null) {
      throw new AramoError('NOT_FOUND', 'Tenant not found', 404, {
        requestId: args.requestId,
        details: { tenant_id: args.tenantId },
      });
    }

    const changedFields = PROFILE_FIELDS.filter(
      (f) => f in patch && (patch[f] ?? null) !== current[f],
    );
    if (changedFields.length === 0) {
      // No-op: nothing actually changed → no write, no audit.
      return { view: toView(current), changedFields: [] };
    }

    const applied: Record<string, string | null> = {};
    for (const f of changedFields) applied[f] = patch[f] ?? null;
    const updated = await this.tenants.updateProfile(args.tenantId, applied);
    return { view: toView(updated), changedFields };
  }
}

function toView(row: TenantProfileRow): TenantProfileView {
  return {
    id: row.id,
    name: row.name,
    legal_name: row.legal_name,
    display_name: row.display_name,
    address_line1: row.address_line1,
    address_line2: row.address_line2,
    city: row.city,
    state_province: row.state_province,
    postal_code: row.postal_code,
    country_code: row.country_code,
    tax_id: row.tax_id,
    registration_number: row.registration_number,
    primary_contact_name: row.primary_contact_name,
    primary_contact_email: row.primary_contact_email,
    primary_contact_phone: row.primary_contact_phone,
    logo_url: row.logo_url,
    updated_at: row.updated_at.toISOString(),
  };
}
