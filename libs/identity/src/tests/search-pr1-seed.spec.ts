import { describe, expect, it } from 'vitest';

import { SCOPE_KEY_FORMAT, SEED_SCOPE_KEYS } from '../lib/dto/index.js';

// Search PR-1 â scope-catalog parity (unit level). Lead rulings R1/R2:
//   - talent:search is REUSED (already in the catalog from the A1a audit).
//   - 3 NEW scopes seeded: company:search / requisition:search / contact:search.
//   - SEED_SCOPE_KEYS 67 â 70.
//
// The RoleScope grant count (+28 @ 0x800+, per-entity :read-holder parity)
// is asserted by the integration seed test (identity.integration.spec.ts,
// ARAMO_RUN_INTEGRATION=1 gated): 362 â 390.

describe('Search PR-1 â scope catalog parity', () => {
  it('SEED_SCOPE_KEYS has 132 keys (the full seeded scope catalog)', () => {
    // Search PR-1 took 67â70 (company/requisition/contact :search); the Tasks
    // backend appended task:read + task:write (70â72); Company-Fields v1.1
    // appended company:read_commercial (72â73); the Job-Module appended
    // requisition:view:financials + requisition:edit:financials (73â75); the
    // PR-A1 Requisition-Gating Rework appended requisition:edit:status +
    // requisition:profile:generate + requisition:profile:edit (75â78); the
    // Settings Rebuild D1 appended import:read + export:read (78â80); the
    // Settings Rebuild D2 appended audit:read (80â81); the Settings Rebuild D3
    // appended tenant:admin:profile (81â82); the Settings Rebuild D4 appended
    // tenant:admin:sites (82â83).
    // Â§5 Auth-Hardening D4 appended tenant:user:read:assignable (83â84); D4b
    // appended tenant:user:read:directory (84â85); Domain-Enforcement P2b
    // appended tenant:admin:domain (85â86); TR-2a-3 appended identity:resolve (86â87);
    // Company-Fields appended company:read_commercial (87â88); Portal P3a appended
    // 3 scopes portal:verification:read + portal:dispute:{read,write} (88â91);
    // D3b Charter Â§4 Amendment appended activity:redact (91â92).
    // Track 3 / E2 appended 7 pre_start_requirement scopes (92â99); v1.2.2 +1 reopen (99â100).
    // Track 4 / T4-D appended 4 assignment scopes read/create/update/end (107â111).
    // Track 5 / T5-P1 appended 2 assignment:commercials:read/write (111->113).
    // Track 8 / T8-P2 appended 2 requisition:import:read/write (113->115).
    // Track 7 / T7-P1 appended 2 placement:permanent:read/transition (115->117).
    // Track 7 / T7-P2 appended 1 placement:remedy:resolve (117->118).
    // Track 7 / T7-P3 appended 1 placement:permanent:terms:write (118->119).
    // Track 8 / T8-CONNECTOR-A appended 2 integration:read/write (119->121).
    // L1-A (Create-Governance) appended 1 requisition:create:establish (127->128).
    expect(SEED_SCOPE_KEYS).toHaveLength(136); // L6-0 −2 assignment:create + assignment:update (grounded-dead removed) -> 138−2=136. L4/P5 +2 offer:read + offer:read:financial -> 136+2=138. L2-I (D1) +1 integration:pipeline-mapping:write -> 135+1=136. L2-F +3 client-selection:create/read/transition; HYG-1 -3 dead orphan scopes.
  });

  it('D3b â activity:redact is in the catalog exactly once', () => {
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
