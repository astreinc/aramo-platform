import { describe, expect, it } from 'vitest';

import {
  INTELLIGENCE_DISPUTES_SCOPE,
  INTELLIGENCE_PROPOSALS_SCOPE,
  LIFECYCLE_REFUSAL_CODES,
  LIFECYCLE_REFUSAL_HTTP_STATUS,
  formatReferenceParam,
  isIntelligenceScope,
  parseReferenceParams,
  validateActProposalRequest,
  validateContradictionResolutionRequest,
  validateDismissProposalRequest,
  validateOpenDisputeRequest,
  validateRespondDisputeRequest,
  validateTenantDisputeActionRequest,
  validateWithdrawDisputeRequest,
} from '../index.js';

// ATI-SEP-1 T10 — closed request validators of the evidence-lifecycle surface.

const CTX = { source_system_id: 'ARAMO_ATS', source_tenant_id: 'tenant-a', external_talent_id: 'talent-1' };
const UUID = '0190ffff-0000-7000-8000-000000000001';

describe('lifecycle contracts', () => {
  it('scopes are registered and every refusal code has an HTTP status', () => {
    expect([INTELLIGENCE_DISPUTES_SCOPE, INTELLIGENCE_PROPOSALS_SCOPE].every(isIntelligenceScope)).toBe(true);
    expect(LIFECYCLE_REFUSAL_CODES.every((c) => typeof LIFECYCLE_REFUSAL_HTTP_STATUS[c] === 'number')).toBe(true);
  });

  it('open dispute: closed schema, uuid assertion, statement 1–4000', () => {
    expect(validateOpenDisputeRequest({ portal_context: CTX, assertion_id: UUID, statement: 'wrong' }).ok).toBe(true);
    const bad = validateOpenDisputeRequest({ portal_context: { ...CTX, x: 1 }, assertion_id: 'nope', statement: ' ', y: 2 });
    expect(bad.ok ? [] : bad.issues).toEqual([
      '$.y: unknown key',
      '$.portal_context.x: unknown key',
      '$.assertion_id: a uuid',
      '$.statement: 1-4000 characters',
    ]);
    expect(validateOpenDisputeRequest({ portal_context: CTX, assertion_id: UUID, statement: 'a'.repeat(4001) }).ok).toBe(false);
    expect(validateOpenDisputeRequest({ portal_context: { ...CTX, source_system_id: 'X' }, assertion_id: UUID, statement: 's' }).ok).toBe(false);
  });

  it('respond / withdraw', () => {
    expect(validateRespondDisputeRequest({ portal_context: CTX, statement: 's' }).ok).toBe(true);
    expect(validateRespondDisputeRequest({ portal_context: CTX }).ok).toBe(false);
    expect(validateWithdrawDisputeRequest({ portal_context: CTX }).ok).toBe(true);
    expect(validateWithdrawDisputeRequest({ portal_context: CTX, actor: 'bad actor' }).ok).toBe(false);
  });

  it('tenant actions: note required vs forbidden', () => {
    expect(validateTenantDisputeActionRequest({ source_tenant_id: 't', actor: 'u' }, 'forbidden').ok).toBe(true);
    expect(validateTenantDisputeActionRequest({ source_tenant_id: 't', actor: 'u', note: 'n' }, 'forbidden').ok).toBe(false);
    expect(validateTenantDisputeActionRequest({ source_tenant_id: 't', actor: 'u' }, 'required').ok).toBe(false);
    expect(validateTenantDisputeActionRequest({ source_tenant_id: 't', actor: 'u', note: 'n' }, 'required').ok).toBe(true);
  });

  it('proposals + contradiction resolution: closed vocabularies', () => {
    expect(validateDismissProposalRequest({ source_tenant_id: 't', actor: 'u', justification: 'j' }).ok).toBe(true);
    expect(validateDismissProposalRequest({ source_tenant_id: 't', actor: 'u' }).ok).toBe(false);
    expect(validateActProposalRequest({ source_tenant_id: 't', actor: 'u', action: 'VERIFICATION_REQUESTED' }).ok).toBe(true);
    expect(validateActProposalRequest({ source_tenant_id: 't', actor: 'u', action: 'MERGE' }).ok).toBe(false);
    expect(validateContradictionResolutionRequest({ resolution: 'KEEP', reason: 'r', actor: 'u' }).ok).toBe(true);
    expect(validateContradictionResolutionRequest({ resolution: 'DELETE', reason: 'r', actor: 'u' }).ok).toBe(false);
  });

  it('reference query parameter: SOURCE/TENANT/TALENT, repeatable, de-duplicated, bounded', () => {
    expect(formatReferenceParam(CTX as never)).toBe('ARAMO_ATS/tenant-a/talent-1');
    const ok = parseReferenceParams(['ARAMO_ATS/tenant-a/talent-1', 'ARAMO_ATS/tenant-a/talent-1', 'ARAMO_ATS/tenant-b/t2']);
    expect(ok.ok ? ok.value.length : -1).toBe(2);
    expect(parseReferenceParams(undefined).ok).toBe(false);
    expect(parseReferenceParams('ARAMO_ATS/only-two').ok).toBe(false);
    expect(parseReferenceParams(Array.from({ length: 51 }, (_, i) => `ARAMO_ATS/t/${i}`)).ok).toBe(false);
  });
});
