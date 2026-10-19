import type { EnvelopeDetail } from '../api';

// Send readiness — mirrors the server's send check (SenderEnvelopeService.readiness):
// ≥1 document, ≥1 signer, and every signer has a SIGNATURE field.
export function readinessOf(d: EnvelopeDetail): { ok: boolean; items: { ok: boolean; t: string }[] } {
  const items: { ok: boolean; t: string }[] = [];
  items.push({ ok: d.documents.length > 0, t: d.documents.length > 0 ? `${d.documents.length} document(s) attached` : 'Add at least one document' });
  items.push({ ok: d.recipients.length > 0, t: d.recipients.length > 0 ? `${d.recipients.length} signer(s)` : 'Add at least one signer' });
  for (const r of d.recipients) {
    if (!d.fields.some((f) => f.signer_id === r.id && f.field_type === 'SIGNATURE')) items.push({ ok: false, t: `${r.name} needs a signature field` });
  }
  return { ok: items.every((i) => i.ok), items };
}
