import { isCopyRecipient, type EnvelopeDetail } from '../api';

// Send readiness — mirrors the server's send check (SenderEnvelopeService.readiness):
// ≥1 document, ≥1 signer, every signer has a SIGNATURE field, and (Aramo-Sign-Unified-
// Product-Amendment-M-A5 §1.5) a recipient who receives a copy has no fields and never
// counts as a signer.
export function readinessOf(d: EnvelopeDetail): { ok: boolean; items: { ok: boolean; t: string }[] } {
  const items: { ok: boolean; t: string }[] = [];
  const signers = d.recipients.filter((r) => !isCopyRecipient(r));
  items.push({ ok: d.documents.length > 0, t: d.documents.length > 0 ? `${d.documents.length} document(s) attached` : 'Add at least one document' });
  items.push({ ok: signers.length > 0, t: signers.length > 0 ? `${signers.length} signer(s)` : 'Add at least one signer' });
  for (const r of d.recipients) {
    if (isCopyRecipient(r)) {
      if (d.fields.some((f) => f.signer_id === r.id)) items.push({ ok: false, t: `${r.name} receives a copy and cannot have fields` });
      continue;
    }
    if (!d.fields.some((f) => f.signer_id === r.id && f.field_type === 'SIGNATURE')) items.push({ ok: false, t: `${r.name} needs a signature field` });
  }
  return { ok: items.every((i) => i.ok), items };
}
