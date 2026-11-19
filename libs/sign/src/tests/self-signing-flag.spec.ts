// UAT SND-11 (Web Self-Signing A2, amendment A3) — the signing page's self_signing flag: true
// only for a "Sign a document" envelope (envelope_mode SELF) in its SELF session.
import { describe, expect, it } from 'vitest';

import { EsignService, type SessionContext } from '../lib/esign.service.js';

const CTX: SessionContext = { session_id: 's', tenant_id: 't', envelope_id: 'e', signer_id: 'g' };

function svc(envelopeMode: string, origin: string | null) {
  const s = Object.create(EsignService.prototype) as EsignService;
  Object.assign(s, {
    repo: { getEnvelope: async () => ({ envelope_mode: envelopeMode }) },
    prisma: { signingSession: { findFirst: async () => ({ origin }) } },
  });
  return s;
}

describe('isSelfSigning', () => {
  it('true for a SELF envelope in its SELF session', async () => {
    expect(await svc('SELF', 'SELF').isSelfSigning(CTX)).toBe(true);
  });

  it('false for a SELF session on a standard envelope (W1 "Sign now": Decline still applies)', async () => {
    expect(await svc('STANDARD', 'SELF').isSelfSigning(CTX)).toBe(false);
  });

  it('false for an emailed link, an inbox or an in-person session', async () => {
    for (const origin of [null, 'LINK', 'INBOX', 'HOSTED']) expect(await svc('SELF', origin).isSelfSigning(CTX)).toBe(false);
  });
});
