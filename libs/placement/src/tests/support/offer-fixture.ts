import { resolve } from 'node:path';

import { v7 as uuidv7 } from 'uuid';

// Offer Lifecycle (D6) — shared test fixture for the placement-create re-point.
//
// A PlacementProcess is now created DOWNSTREAM of an ACCEPTED Offer (R-PRECEDENCE,
// repository-enforced). Tests that create placements must first seed an ACCEPTED
// offer and pass its id — this helper is the ONE reusable seam (never 61 inline
// duplications, never a test-only bypass of createPlacement).

// The two offer migrations every curated placement migration-harness must apply
// (the offer schema + the placement.offer_id column) so createPlacement's
// ACCEPTED-offer lookup and the offer_id write resolve.
export function offerMigrationPaths(placementMigrationsDir: string): string[] {
  return [
    resolve(placementMigrationsDir, '20260824120000_init_offer_model/migration.sql'),
    resolve(placementMigrationsDir, '20260824130000_placement_offer_id/migration.sql'),
  ];
}

// Minimal Prisma-ish surface the helper needs (satisfied by the placement PrismaService).
interface OfferSeedClient {
  offer: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
  };
}

// Seed an ACCEPTED offer and return its id. The repository ACCEPTED-check keys on
// (tenant_id, id, state=ACCEPTED) only — it does not submittal-match — so a single
// seeded ACCEPTED offer can back many placement creates within a tenant. Inserting
// directly at ACCEPTED is permitted (ACCEPTED is terminal → the one-live INSERT
// guard does not fire).
export async function seedAcceptedOffer(
  prisma: OfferSeedClient,
  overrides: {
    tenant_id: string;
    submittal_id?: string;
    requisition_id?: string;
    talent_record_id?: string;
  },
): Promise<string> {
  const id = uuidv7();
  await prisma.offer.create({
    data: {
      id,
      tenant_id: overrides.tenant_id,
      submittal_id: overrides.submittal_id ?? uuidv7(),
      requisition_id: overrides.requisition_id ?? uuidv7(),
      talent_record_id: overrides.talent_record_id ?? uuidv7(),
      state: 'ACCEPTED',
    },
  });
  return id;
}

// Direct DB seed of a PlacementProcess at an EXPLICIT state — for legacy
// offer-phase transition-edge tests ONLY (e.g. OFFER_EXTENDED → OFFER_ACCEPTED),
// which exercise the historical transition graph, not the new creation command.
// Bypasses createPlacement deliberately (the row is placed in a state a new
// create no longer births at); offer_id stays NULL (a legacy row). The lifecycle
// trigger's BEFORE INSERT one-live guard still applies.
interface PlacementSeedClient {
  placementProcess: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string; state: string }>;
  };
}

export async function seedPlacementAtState(
  prisma: PlacementSeedClient,
  input: {
    tenant_id: string;
    state: string;
    submittal_id?: string;
    requisition_id?: string;
    talent_record_id?: string;
    offered_at?: Date;
  },
): Promise<string> {
  const id = uuidv7();
  await prisma.placementProcess.create({
    data: {
      id,
      tenant_id: input.tenant_id,
      submittal_id: input.submittal_id ?? uuidv7(),
      requisition_id: input.requisition_id ?? uuidv7(),
      talent_record_id: input.talent_record_id ?? uuidv7(),
      state: input.state,
      offered_at: input.offered_at ?? new Date(),
    },
  });
  return id;
}
