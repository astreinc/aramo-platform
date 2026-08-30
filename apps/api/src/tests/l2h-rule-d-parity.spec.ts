import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Lane 2 / L2-H — AC-6 (Rule D) parity: the journey module DERIVES from each owner's imported
// state surface; it NEVER re-declares an owner's state-value list. Sub-state TYPES flow from the
// owner Views via indexed access (compile-time: an owner adding a state value surfaces here with
// no local edit), and stage derivation imports each owner's position/ordinal surface. Negative
// control: a re-declared owner state-value literal array in the journey module fails this check.
const HERE = resolve(__dirname, '..');
const dto = readFileSync(resolve(HERE, 'talent-journey/dto/talent-journey.view.ts'), 'utf8');
const svc = readFileSync(resolve(HERE, 'talent-journey/talent-journey-read.service.ts'), 'utf8');

describe('L2-H AC-6 — owner state tuples derived, not copied (Rule D)', () => {
  it('sub-state types are derived from each owner View via indexed access (never a local union)', () => {
    // Each owner sub-state is `OwnerView['field']` — imported from the owner, not restated.
    expect(dto).toMatch(/PipelineView\['status'\]/);
    expect(dto).toMatch(/TalentSubmittalRecordView\['state'\]/);
    expect(dto).toMatch(/ClientSelectionProcessView\['state'\]/);
    expect(dto).toMatch(/InterviewSessionView\['state'\]/);
    expect(dto).toMatch(/OfferView\['state'\]/);
    expect(dto).toMatch(/PlacementProcessView\['state'\]/);
    expect(dto).toMatch(/ContractAssignmentView\['lifecycle_state'\]/);
  });

  it('the composer imports each owner ordinal/terminal surface (R2), not a re-authored mapping', () => {
    expect(svc).toMatch(/OFFER_STATE_POSITION/);
    expect(svc).toMatch(/STATE_POSITION as PLACEMENT_STATE_POSITION/);
    expect(svc).toMatch(/ACTIVE_FLOW_STAGES/);
    expect(svc).toMatch(/isUnresolvedStatus/);
  });

  it('NEGATIVE CONTROL — no owner state-value literal array is re-declared in the journey module', () => {
    // A re-declared owner ontology (e.g. the client-selection or offer value list) as a bare
    // literal array is the Rule-D violation this guards. The journey funnel vocabulary
    // (JOURNEY_STAGE_ORDER) is L2-H's OWN vocabulary and is legitimately local.
    const ownerLiteralSets = [
      /\[\s*'CLIENT_REVIEW'\s*,\s*'INTERVIEW'\s*,\s*'SELECTED'/, // client-selection tuple
      /\[\s*'DRAFT'\s*,\s*'SENT'\s*,\s*'NEGOTIATION'/, // offer tuple
      /\[\s*'PRE_START'\s*,\s*'BLOCKED'\s*,\s*'READY_TO_START'/, // placement tuple
      /\[\s*'PENDING'\s*,\s*'IN_PROGRESS'\s*,\s*'SATISFIED'/, // requirement tuple
    ];
    for (const re of ownerLiteralSets) {
      expect(svc).not.toMatch(re);
      expect(dto).not.toMatch(re);
    }
  });
});
