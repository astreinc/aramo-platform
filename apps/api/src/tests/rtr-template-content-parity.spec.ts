import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

import { DEFAULT_RTR_TEMPLATE_CONTENT_V1 } from '../rtr/rtr-template-content.js';

// RTR-TEMPLATE-1 (§28) — the RTR default content exists in exactly two places:
// the TS constant (consumed by the resolver/binding) and the backfill migration
// SQL (raw SQL cannot import TS). This test asserts they are byte-identical as
// parsed JSON, so the seeded sentinel/tenant templates and the runtime contract
// can never drift. If the default legal body changes, both must change together.
describe('RTR default template content parity (TS constant vs backfill migration)', () => {
  it('backfill migration field_schema JSON deep-equals DEFAULT_RTR_TEMPLATE_CONTENT_V1', () => {
    const migrationSql = readFileSync(
      new URL(
        '../../../../libs/documents/prisma/migrations/20261004120000_rtr_template_1_default_rtr_template_backfill/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const match = migrationSql.match(/'(\{"render_schema_version".*?\})'::jsonb/s);
    expect(match, 'backfill migration must embed the field_schema JSON literal').not.toBeNull();
    const migrationContent = JSON.parse(match?.[1] ?? '{}');
    expect(migrationContent).toEqual(DEFAULT_RTR_TEMPLATE_CONTENT_V1);
  });
});
