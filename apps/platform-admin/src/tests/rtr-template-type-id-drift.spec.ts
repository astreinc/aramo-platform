import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

import { RIGHT_TO_REPRESENT_TYPE_ID } from '../app/platform/tenant-document-template-provisioning.service.js';

// RTR-TEMPLATE-1 (PO guardrail) — the duplicated RIGHT_TO_REPRESENT type-id in
// platform-admin is an EXPLICIT, VERIFIED hand-sync boundary (scope:platform must
// not import the scope:ats apps/api constant), never a second source of truth.
// This test fails LOUDLY the moment the platform-admin literal drifts from the
// actually-seeded RIGHT_TO_REPRESENT DocumentType (the doc5 seed migration is the
// authoritative seeded source). Keeps the new-tenant provisioning copy pointed at
// the real seeded type.
describe('RTR provisioning type-id hand-sync', () => {
  it('matches the seeded RIGHT_TO_REPRESENT DocumentType id in the doc5 seed migration', () => {
    const seedSql = readFileSync(
      new URL(
        '../../../../libs/documents/prisma/migrations/20260923170000_doc5_seed_rtr_document_type/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    // The seed row: VALUES ('<uuid>', NULL, 'RIGHT_TO_REPRESENT', ...)
    const match = seedSql.match(/'([0-9a-fA-F-]{36})',\s*NULL,\s*'RIGHT_TO_REPRESENT'/);
    expect(match, 'doc5 migration must seed a RIGHT_TO_REPRESENT DocumentType row').not.toBeNull();
    const seededId = match?.[1];
    expect(seededId).toBe(RIGHT_TO_REPRESENT_TYPE_ID);
  });
});
