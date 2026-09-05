import { describe, expect, it } from 'vitest';

import { SEED_SCOPE_KEYS } from '../lib/dto/index.js';

// Company-Fields v1.1 â scope-catalog parity (unit tier). The authoritative
// GRANT-TABLE proof (which roles hold company:read_commercial) is the
// real-DB resolve in identity.integration.spec.ts ("Company-Fields v1.1 â
// grant-table"); this unit spec pins the catalog entry exists exactly once.
describe('Company-Fields v1.1 â company:read_commercial catalog parity', () => {
  it('SEED_SCOPE_KEYS contains company:read_commercial exactly once', () => {
    expect(SEED_SCOPE_KEYS).toContain('company:read_commercial');
    expect(
      SEED_SCOPE_KEYS.filter((k) => k === 'company:read_commercial'),
    ).toHaveLength(1);
  });

  it('SEED_SCOPE_KEYS is 132 (107 + 4 Track4/T4-D assignment + 1 Slice#3 assignment:extend + 2 Track5/T5-P1 assignment:commercials + 2 Track8/T8-P2 requisition:import + 2 Track7/T7-P1 placement:permanent + 1 Track7/T7-P2 placement:remedy:resolve + 1 Track7/T7-P3 placement:permanent:terms:write + 2 Track8/T8-CONNECTOR-A integration + 1 L1-A requisition:create:establish + 4 COMM-B2 communication)', () => {
    expect(SEED_SCOPE_KEYS).toHaveLength(139); // COMM-C3 +2 engagement:policy:read + engagement:policy:write → 139. L5-P6 +1 pre_start_requirement:verify → 137. L6-0 −2 assignment:create + assignment:update (grounded-dead removed) -> 138−2=136. L4/P5 +2 offer:read + offer:read:financial -> 136+2=138. L2-I (D1) +1 integration:pipeline-mapping:write -> 135+1=136. L2-F +3 client-selection:create/read/transition; HYG-1 -3 dead orphan scopes.
  });
});
