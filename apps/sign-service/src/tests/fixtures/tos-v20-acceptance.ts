import { randomUUID } from 'node:crypto';

import { LEGAL_DOCUMENTS } from '@aramo/subscription';
import type { Client } from 'pg';

// ToS v2.0 (effective 2026-11-01 23:00 EST) — from that instant a Business sender who has not
// accepted the Aramo Sign Terms of Service is refused (legal_acceptance_required). Integration specs
// whose Business senders send from the console record that acceptance up front, so their outcome
// does not depend on the wall clock (before the instant nothing is owed and the row is inert).
const TOS_V20 = LEGAL_DOCUMENTS.find((d) => d.key === 'sign.terms_of_service' && d.version === '2.0')!;

export async function acceptTosV20(db: Pick<Client, 'query'>, tenant_id: string, user_id: string, email: string): Promise<void> {
  await db.query(
    `INSERT INTO subscription."LegalAcceptance" (id, tenant_id, user_id, subject_email, document_key, version, sha256, context, context_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,'IN_APP',$8)`,
    [randomUUID(), tenant_id, user_id, email, TOS_V20.key, TOS_V20.version, TOS_V20.sha256, `in_app:${tenant_id}:${user_id}`],
  );
}
