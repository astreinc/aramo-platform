import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/identity-verification/identity-gate.js', () => ({ assertIdentityVerificationCleared: vi.fn(async () => undefined) }));
vi.mock('../lib/regulated/qes-guard.js', () => ({ assertQesSatisfied: vi.fn(async () => undefined) }));

import { SignatureFieldIncompleteError, SignatureFieldValueRefusedError } from '../lib/domain/errors.js';
import { EsignService, type SessionContext } from '../lib/esign.service.js';

// FIELD-PARITY-2 (Aramo-Sign-Field-Placement-Conditional-Fields-Directive-v1_0-LOCKED) §4.2 B-5,
// §5 test 1 (clearing along chains) — fillField refuses a hidden field (field_hidden) and clears
// the values a trigger change hides, recursively, in the same transaction; completion uses the
// one visibility rule and never stamps a hidden SIGN_DATE. A stateful stub transaction (the gates
// and the database are the integration specs').

const ctx: SessionContext = { session_id: 'sess-1', tenant_id: 't1', envelope_id: 'e1', signer_id: 's1' };
type Row = Record<string, unknown> & { id: string };

function engine(fields: Row[]) {
  const rows = fields.map((f) => ({ field_type: 'TEXT', required: false, value: null, filled_at: null, name_mode: null, group_key: null, group_rule: null, min_selected: null, signer_id: 's1', field_key: null, condition: null, sender_filled: false, read_only: false, validation: null, options: null, signature_method: null, ...f }));
  const byId = (id: string) => rows.find((r) => r.id === id);
  const tx = {
    signatureField: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => byId(where.id) ?? null),
      findMany: vi.fn(async () => rows.map((r) => ({ ...r }))),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(byId(where.id) ?? {}, data)),
      updateMany: vi.fn(async ({ where, data }: { where: { id?: { in?: string[]; not?: string }; group_key?: string; field_type?: string }; data: Record<string, unknown> }) => {
        for (const r of rows) {
          const id = where.id;
          if (id?.in !== undefined && !id.in.includes(r.id)) continue;
          if (id?.not !== undefined && (r.id === id.not || r['group_key'] !== where.group_key || r['field_type'] !== where.field_type)) continue;
          Object.assign(r, data);
        }
        return { count: 0 };
      }),
    },
    signatureEnvelope: {
      findFirst: vi.fn(async () => ({ signer_date_format: 'YYYY-MM-DD' })),
      findFirstOrThrow: vi.fn(async () => ({ routing_mode: 'PARALLEL' })),
    },
    signer: {
      update: vi.fn(async () => ({})),
      findFirstOrThrow: vi.fn(async () => ({ name: 'Alex Signer' })),
      findMany: vi.fn(async () => [
        { id: 's1', status: 'SIGNED', recipient_kind: 'SIGNER', signing_order: 1, witness_for_signer_id: null },
        { id: 's2', status: 'PENDING', recipient_kind: 'SIGNER', signing_order: 2, witness_for_signer_id: null },
      ]),
    },
    signingSession: { update: vi.fn(async () => ({})) },
  };
  const prisma = { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
  const repo = { lockSignableEnvelope: vi.fn(async () => 'IN_PROGRESS'), appendEvent: vi.fn(async () => 'ev-1') };
  const svc = new EsignService(prisma as never, repo as never, {} as never);
  const gates = svc as unknown as Record<string, unknown>;
  gates['assertLiveSession'] = vi.fn(async () => ({ origin: null, host_user_id: null, authenticated_user_id: null }));
  gates['assertEligible'] = vi.fn(async () => undefined);
  gates['assertAccessCodeCleared'] = vi.fn(async () => undefined);
  gates['hasAcceptedDisclosure'] = vi.fn(async () => true);
  gates['profileNameFor'] = vi.fn(async () => 'Alex Signer');
  return { svc, rows, byId };
}

const now = new Date('2026-11-23T12:00:00Z');
const sig = { id: 'sig', field_type: 'SIGNATURE', required: true, value: 'data:image/png;base64,AA', filled_at: now };

describe('FIELD-PARITY-2 B-5 — fill', () => {
  it('refuses filling a hidden field (field_hidden) and accepts it once its trigger shows it', async () => {
    const { svc, byId } = engine([
      sig,
      { id: 'box', field_type: 'CHECKBOX', field_key: 'agree' },
      { id: 'dep', field_type: 'TEXT', field_key: 'detail', condition: { trigger_key: 'agree', when: 'checked' } },
    ]);
    await expect(svc.fillField(ctx, 'dep', { value: 'x' })).rejects.toMatchObject({ reason: 'field_hidden' });
    await expect(svc.fillField(ctx, 'dep', { value: 'x' })).rejects.toBeInstanceOf(SignatureFieldValueRefusedError);
    await svc.fillField(ctx, 'box', { value: 'true' });
    await svc.fillField(ctx, 'dep', { value: 'x' });
    expect(byId('dep')).toMatchObject({ value: 'x' });
  });

  it('unticking a trigger clears its dependents along the chain, in the same transaction (C-3)', async () => {
    const { svc, byId } = engine([
      sig,
      { id: 'a', field_type: 'CHECKBOX', field_key: 'a', value: 'true', filled_at: now },
      { id: 'b', field_type: 'CHECKBOX', field_key: 'b', value: 'true', filled_at: now, condition: { trigger_key: 'a', when: 'checked' } },
      { id: 'c', field_type: 'TEXT', field_key: 'c', value: 'typed', filled_at: now, condition: { trigger_key: 'b', when: 'checked' } },
      { id: 'other', field_type: 'TEXT', field_key: 'o', value: 'kept', filled_at: now },
    ]);
    await svc.fillField(ctx, 'a', { value: 'false' });
    expect(byId('b')).toMatchObject({ value: null, filled_at: null });
    expect(byId('c')).toMatchObject({ value: null, filled_at: null });
    expect(byId('other')).toMatchObject({ value: 'kept' });
  });

  it('choosing another radio option clears what the first option showed', async () => {
    const { svc, byId } = engine([
      sig,
      { id: 'yes', field_type: 'RADIO', field_key: 'yes', group_key: 'g', group_rule: 'SELECT_ONE', value: 'true', filled_at: now },
      { id: 'no', field_type: 'RADIO', field_key: 'no', group_key: 'g', group_rule: 'SELECT_ONE' },
      { id: 'why', field_type: 'TEXT', field_key: 'why', value: 'because', filled_at: now, condition: { trigger_key: 'yes', when: 'chosen' } },
    ]);
    await svc.fillField(ctx, 'no', { value: 'true' });
    expect(byId('yes')).toMatchObject({ value: 'false' });
    expect(byId('why')).toMatchObject({ value: null, filled_at: null });
  });
});

describe('FIELD-PARITY-2 B-5 — complete', () => {
  it('a hidden required field does not block completion; a hidden SIGN_DATE / name is never stamped', async () => {
    const { svc, byId } = engine([
      sig,
      { id: 'box', field_type: 'CHECKBOX', field_key: 'agree' },
      { id: 'dep', field_type: 'TEXT', required: true, condition: { trigger_key: 'agree', when: 'checked' } },
      { id: 'date', field_type: 'SIGN_DATE', required: true, condition: { trigger_key: 'agree', when: 'checked' } },
      { id: 'name', field_type: 'SIGNER_NAME', required: true, name_mode: 'SIGNER_PROFILE', condition: { trigger_key: 'agree', when: 'checked' } },
    ]);
    await expect(svc.completeSigner(ctx)).resolves.toMatchObject({ envelope_status: 'IN_PROGRESS' });
    expect(byId('date')).toMatchObject({ value: null, filled_at: null });
    expect(byId('name')).toMatchObject({ value: null, filled_at: null });
  });

  it('once shown, the dependent is required again', async () => {
    const { svc } = engine([
      sig,
      { id: 'box', field_type: 'CHECKBOX', field_key: 'agree', value: 'true', filled_at: now },
      { id: 'dep', field_type: 'TEXT', required: true, condition: { trigger_key: 'agree', when: 'checked' } },
    ]);
    await expect(svc.completeSigner(ctx)).rejects.toBeInstanceOf(SignatureFieldIncompleteError);
  });
});
