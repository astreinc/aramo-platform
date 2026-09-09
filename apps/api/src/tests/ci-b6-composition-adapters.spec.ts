import { describe, expect, it, vi } from 'vitest';
import type { CommunicationsRepository } from '@aramo/communications';
import type { ConsentService } from '@aramo/consent';
import {
  canonicalBytes,
  sha256Hex,
  type ConversationTranscriptRepository,
  type NormalizedTranscript,
} from '@aramo/conversation-transcript';
import type { ObjectStorageService } from '@aramo/object-storage';

import { AiProcessingConsentGate } from '../conversation-intelligence/ai-processing-consent.gate.js';
import { ObjectStorageNormalizedTranscriptSource } from '../conversation-intelligence/normalized-transcript-source.adapter.js';

// ---- AiProcessingConsentGate (real gate; fakes for repo + consent) ----
function consentGate(opts: { talentIds: string[]; result: 'allowed' | 'denied' | 'error' }) {
  const comms = { findTalentSubjectIdsForInteraction: vi.fn(async () => opts.talentIds) } as unknown as CommunicationsRepository;
  const checkOperationForService = vi.fn(async (i: { operation: string }) => ({ result: opts.result, decision_id: `d-${i.operation}` }));
  const consent = { checkOperationForService } as unknown as ConsentService;
  return { g: new AiProcessingConsentGate(comms, consent), checkOperationForService };
}

describe('CI-B6 AiProcessingConsentGate', () => {
  const input = { tenant_id: 't', interaction_id: 'i' };
  it('zero talent → no_talent (consent not called)', async () => {
    const { g, checkOperationForService } = consentGate({ talentIds: [], result: 'allowed' });
    await expect(g.evaluate(input)).resolves.toEqual({ allowed: false, reason: 'no_talent' });
    expect(checkOperationForService).not.toHaveBeenCalled();
  });
  it('ambiguous talent → ambiguous_talent', async () => {
    const { g } = consentGate({ talentIds: ['a', 'b'], result: 'allowed' });
    await expect(g.evaluate(input)).resolves.toEqual({ allowed: false, reason: 'ambiguous_talent' });
  });
  it('one talent + allowed → allowed (checks ai_processing operation)', async () => {
    const { g, checkOperationForService } = consentGate({ talentIds: ['a'], result: 'allowed' });
    const r = await g.evaluate(input);
    expect(r.allowed).toBe(true);
    expect(checkOperationForService).toHaveBeenCalledWith(expect.objectContaining({ operation: 'ai_processing' }));
  });
  it('denied → denied (fail closed); error → denied', async () => {
    await expect(consentGate({ talentIds: ['a'], result: 'denied' }).g.evaluate(input)).resolves.toEqual({ allowed: false, reason: 'denied' });
    await expect(consentGate({ talentIds: ['a'], result: 'error' }).g.evaluate(input)).resolves.toEqual({ allowed: false, reason: 'denied' });
  });
});

// ---- ObjectStorageNormalizedTranscriptSource (real adapter; fakes for repo + storage) ----
const TENANT = '11111111-1111-4111-8111-111111111111';
const TXID = '22222222-2222-4222-8222-222222222222';
const IXID = '33333333-3333-4333-8333-333333333333';

function normalized(): NormalizedTranscript {
  return {
    schema_version: 'conversation-transcript.normalized.v1',
    transcript_id: TXID,
    tenant_id: TENANT,
    interaction_id: IXID,
    provider_key: 'zoom_phone',
    provider_transcript_id: 'pt-1',
    source_sha256: 'a'.repeat(64),
    utterances: [{ utterance_id: 'utt_1', ordinal: 0, speaker_role: 'RECRUITER', text: 'hello there' }],
  };
}

function transcriptSource(opts: { row: unknown; bytes?: Buffer }) {
  const transcripts = { findByIdInTenant: vi.fn(async () => opts.row) } as unknown as ConversationTranscriptRepository;
  const getObjectBytes = vi.fn(async () => {
    if (opts.bytes === undefined) throw new Error('not found');
    return opts.bytes;
  });
  const storage = { getObjectBytes } as unknown as ObjectStorageService;
  return new ObjectStorageNormalizedTranscriptSource(transcripts, storage);
}

describe('CI-B6 ObjectStorageNormalizedTranscriptSource', () => {
  it('ready: reads + verifies hash + parses to the view', async () => {
    const bytes = canonicalBytes(normalized());
    const sha = sha256Hex(bytes);
    const row = { id: TXID, tenant_id: TENANT, interaction_id: IXID, state: 'normalized', normalized_artifact_ref: 'conversation-transcript/t/x/normalized.json', normalized_sha256: sha };
    const out = await transcriptSource({ row, bytes }).load(TENANT, TXID);
    expect(out.status).toBe('ready');
    if (out.status !== 'ready') return;
    expect(out.view.interaction_id).toBe(IXID);
    expect(out.view.utterances[0]!.utterance_id).toBe('utt_1');
  });

  it('not_found when row absent; not_ready when state != normalized', async () => {
    expect((await transcriptSource({ row: null }).load(TENANT, TXID)).status).toBe('not_found');
    const row = { id: TXID, tenant_id: TENANT, interaction_id: IXID, state: 'source_ready', normalized_artifact_ref: null, normalized_sha256: null };
    expect((await transcriptSource({ row }).load(TENANT, TXID)).status).toBe('not_ready');
  });

  it('hash_mismatch when stored bytes do not hash to normalized_sha256', async () => {
    const row = { id: TXID, tenant_id: TENANT, interaction_id: IXID, state: 'normalized', normalized_artifact_ref: 'k', normalized_sha256: 'f'.repeat(64) };
    const out = await transcriptSource({ row, bytes: canonicalBytes(normalized()) }).load(TENANT, TXID);
    expect(out.status).toBe('hash_mismatch');
  });

  it('artifact_not_found when storage read throws', async () => {
    const bytes = canonicalBytes(normalized());
    const row = { id: TXID, tenant_id: TENANT, interaction_id: IXID, state: 'normalized', normalized_artifact_ref: 'k', normalized_sha256: sha256Hex(bytes) };
    const out = await transcriptSource({ row }).load(TENANT, TXID); // no bytes → throws
    expect(out.status).toBe('artifact_not_found');
  });
});
