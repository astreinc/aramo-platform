import { type PrismaService } from '../prisma/prisma.service.js';
import { SignatureFieldIncompleteError } from '../domain/errors.js';

// Feature-Parity §1.16 (Amendment A1) — the QES completion guard.

/**
 * Completion guard (EsignService.completeSigner): a signer who must sign with QES may
 * complete only once the QTSP signature is SIGNED. Runs inside the completing transaction.
 */
export async function assertQesSatisfied(tx: Pick<PrismaService, 'signQesSignature'>, tenant_id: string, signer_id: string): Promise<void> {
  const row = await tx.signQesSignature.findFirst({ where: { tenant_id, signer_id }, select: { state: true } });
  if (row !== null && row.state !== 'SIGNED') throw new SignatureFieldIncompleteError(signer_id, 'qes_signature_pending');
}
