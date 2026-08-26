import { describe, expect, it } from 'vitest';

import { SCOPE_KEY_FORMAT, SEED_SCOPE_KEYS } from '../lib/dto/index.js';

// Search PR-1 — scope-catalog parity (unit level). Lead rulings R1/R2:
//   - talent:search is REUSED (already in the catalog from the A1a audit).
//   - 3 NEW scopes seeded: company:search / requisition:search / contact:search.
//   - SEED_SCOPE_KEYS 67 → 70.
//
// The RoleScope grant count (+28 @ 0x800+, per-entity :read-holder parity)
// is asserted by the integration seed test (identity.integration.spec.ts,
// ARAMO_RUN_INTEGRATION=1 gated): 362 → 390.

describe('Search PR-1 — scope catalog parity', () => {
  it('SEED_SCOPE_KEYS has 132 keys (the full seeded scope catalog)', () => {
    // Search PR-1 took 67→70 (company/requisition/contact :search); the Tasks
    // backend appended task:read + task:write (70→72); Company-Fields v1.1
    // appended company:read_commercial (72→73); the Job-Module appended
    // requisition:view:financials + requisition:edit:financials (73→75); the
    // PR-A1 Requisition-Gating Rework appended requisition:edit:status +
    // requisition:profile:generate + requisition:profile:edit (75→78); the
    // Settings Rebuild D1 appended import:read + export:read (78→80); the
    // Settings Rebuild D2 appended audit:read (80→81); the Settings Rebuild D3
    // appended tenant:admin:profile (81→82); the Settings Rebuild D4 appended
    // tenant:admin:sites (82→83).
    // §5 Auth-Hardening D4 appended tenant:user:read:assignable (83→84); D4b
    // appended tenant:user:read:directory (84→85); Domain-Enforcement P2b
    // appended tenant:admin:domain (85→86); TR-2a-3 appended identity:resolve (86→87);
    // Company-Fields appended company:read_commercial (87→88); Portal P3a appended
    // 3 scopes portal:verification:read + portal:dispute:{read,write} (88→91);
    // D3b Charter §4 Amendment appended activity:redact (91→92).
    // Track 3 / E2 appended 7 pre_start_requirement scopes (92→99); v1.2.2 +1 reopen (99→100).
    // Track 4 / T4-D appended 4 assignment scopes read/create/update/end (107→111).
    // Track 5 / T5-P1 appended 2 assignment:commercials:read/write (111->113).
    // Track 8 / T8-P2 appended 2 requisition:import:read/write (113->115).
    // Track 7 / T7-P1 appended 2 placement:permanent:read/transition (115->117).
    // Track 7 / T7-P2 appended 1 placement:remedy:resolve (117->118).
    // Track 7 / T7-P3 appended 1 placement:permanent:terms:write (118->119).
    // Track 8 / T8-CONNECTOR-A appended 2 integration:read/write (119->121).
    // L1-A (Create-Governance) appended 1 requisition:create:establish (127->128).
    expect(SEED_SCOPE_KEYS).toHaveLength(132);
  });

  it('D3b — activity:redact is in the catalog exactly once', () => {
    expect(SEED_SCOPE_KEYS.filter((k) => k === 'activity:redact')).toHaveLength(
      1,
    );
  });

  it('the 3 NEW per-entity search scopes are in the catalog', () => {
    expect(SEED_SCOPE_KEYS).toContain('company:search');
    expect(SEED_SCOPE_KEYS).toContain('requisition:search');
    expect(SEED_SCOPE_KEYS).toContain('contact:search');
  });

  it('talent:search is REUSED (present from the A1a audit, not re-added)', () => {
    const occurrences = SEED_SCOPE_KEYS.filter((k) => k === 'talent:search');
    expect(occurrences).toHaveLength(1);
  });

  it('all 4 search scope keys match the locked SCOPE_KEY_FORMAT', () => {
    for (const key of [
      'talent:search',
      'company:search',
      'requisition:search',
      'contact:search',
    ]) {
      expect(SCOPE_KEY_FORMAT.test(key), `format ${key}`).toBe(true);
    }
  });
});
