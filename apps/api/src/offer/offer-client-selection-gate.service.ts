import { Inject, Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';

// L3-E — the SELECTED→Offer authorization gate (apps/api composition root).
//
// Ratified rule (P1 / D-4): ClientSelectionProcess.SELECTED is a PRECONDITION for Offer
// creation. SELECTED authorizes the Offer command; it does not auto-create an Offer.
// The authority chain is EXACT and keyed on the offer's own submittal:
//   Offer.submittal_id → Submittal.id → ClientSelectionProcess.submittal_id → SELECTED
// — never "some SELECTED process for the same talent/requisition", so a prior/unrelated
// selection episode cannot authorize a new Offer.
//
// The gate lives here (not in libs/placement) so the Offer aggregate stays pure and does
// not couple to @aramo/client-selection; the cross-schema read rides the placement
// connection (one Postgres, many schemas) via parameterized raw SQL. There is NO
// compatibility bypass: an Offer for a submittal with no SELECTED client-selection is
// refused deterministically with OFFER_CLIENT_SELECTION_NOT_SELECTED (409).

interface RawReadDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

interface StateRow {
  readonly state: string;
}

@Injectable()
export class OfferClientSelectionGate {
  constructor(@Inject('OfferGateDb') private readonly db: RawReadDb) {}

  // Throw OFFER_CLIENT_SELECTION_NOT_SELECTED unless THIS submittal's
  // ClientSelectionProcess exists (same tenant) and is exactly SELECTED.
  async assertSelected(args: {
    tenant_id: string;
    submittal_id: string;
    requestId: string;
  }): Promise<void> {
    const rows = await this.db.$queryRawUnsafe<StateRow[]>(
      `SELECT "state"
         FROM "client_selection"."ClientSelectionProcess"
        WHERE "submittal_id" = $1::uuid AND "tenant_id" = $2::uuid
        LIMIT 1`,
      args.submittal_id,
      args.tenant_id,
    );
    const state = rows[0]?.state ?? null;
    if (state !== 'SELECTED') {
      throw new AramoError(
        'OFFER_CLIENT_SELECTION_NOT_SELECTED',
        'Offer creation requires the client-selection for this submittal to be SELECTED',
        409,
        {
          requestId: args.requestId,
          details: { submittal_id: args.submittal_id, client_selection_state: state },
        },
      );
    }
  }
}
