import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { RequisitionRepository } from '@aramo/requisition';

// Requisition Lane 1-A (Create-Governance) — shared blast-radius helper.
//
// Under create-governance a normal human HTTP `POST /v1/requisitions` now
// establishes `draft` (R-DEFAULT), so a pipeline/add-talent step against that
// requisition is policy-denied (LIFECYCLE_ADD_DENIED). Integration specs whose
// SUBJECT is not requisition-establishment (reporting / export / status-PATCH /
// assignment-visibility) relied on the removed `open` default for their SETUP
// fixture. This helper re-establishes an OPEN requisition through the SANCTIONED
// SYSTEM establishment path — actor_kind:'system' (creation_mode SYSTEM) + the
// bootstrap-held requisition:create:establish scope + an explicit status:'open'
// — the SAME path tools/seed-e2e-data.ts uses. It is deliberately NOT a normal
// human HTTP create, and it does NOT weaken R-DEFAULT: the HTTP create path
// still lands draft; this is a bootstrap/test establishment channel only.
//
// Returns the created RequisitionView (carrying `.id`) so it is a drop-in for
// the `const req = await postJson('/v1/requisitions', jwt, {…})` setup lines.
export async function establishOpenRequisition(
  app: INestApplication,
  args: {
    tenant_id: string;
    entered_by_id: string;
    input: Record<string, unknown>;
  },
): Promise<{ id: string; status: string }> {
  const repo = app.get(RequisitionRepository, { strict: false });
  const view = (await repo.create({
    tenant_id: args.tenant_id,
    entered_by_id: args.entered_by_id,
    // Force the OPEN establishment regardless of any caller-supplied status.
    input: { ...args.input, status: 'open' } as never,
    scopes: ['requisition:create:establish'],
    creation_mode: 'SYSTEM',
    requestId: randomUUID(),
  })) as unknown as { id: string; status: string };
  return view;
}
