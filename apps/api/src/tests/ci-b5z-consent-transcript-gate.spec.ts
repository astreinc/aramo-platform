import { describe, expect, it, vi } from 'vitest';
import type { CommunicationsRepository } from '@aramo/communications';
import type { ConsentService } from '@aramo/consent';

import { ConsentTranscriptGate } from '../conversation-transcript/consent-transcript.gate.js';

// Fakes typed to the concrete classes the gate depends on (no PG, no HTTP).
function gate(opts: {
  talentIds: string[];
  consent: (op: 'recording' | 'transcription') => 'allowed' | 'denied' | 'error';
}) {
  const comms = {
    findTalentSubjectIdsForInteraction: vi.fn(async () => opts.talentIds),
  } as unknown as CommunicationsRepository;
  const checkOperationForService = vi.fn(async (input: { operation: 'recording' | 'transcription' }) => ({
    result: opts.consent(input.operation),
    decision_id: `dec-${input.operation}`,
  }));
  const consent = { checkOperationForService } as unknown as ConsentService;
  return { g: new ConsentTranscriptGate(comms, consent), checkOperationForService };
}

describe('CI-B5Z ConsentTranscriptGate — durable talent + fail-closed recording∧transcription', () => {
  const input = { tenant_id: 't', interaction_id: 'i' };

  it('zero talent associations → talent_resolution none (no consent call)', async () => {
    const { g, checkOperationForService } = gate({ talentIds: [], consent: () => 'allowed' });
    await expect(g.evaluate(input)).resolves.toEqual({ allowed: false, talent_resolution: 'none' });
    expect(checkOperationForService).not.toHaveBeenCalled();
  });

  it('multiple talent associations → talent_resolution ambiguous', async () => {
    const { g } = gate({ talentIds: ['a', 'b'], consent: () => 'allowed' });
    await expect(g.evaluate(input)).resolves.toEqual({ allowed: false, talent_resolution: 'ambiguous' });
  });

  it('exactly one talent + both allowed → allowed', async () => {
    const { g } = gate({ talentIds: ['a'], consent: () => 'allowed' });
    const r = await g.evaluate(input);
    expect(r.allowed).toBe(true);
  });

  it('recording denied → denied_operation recording (transcription NOT checked)', async () => {
    const { g, checkOperationForService } = gate({
      talentIds: ['a'],
      consent: (op) => (op === 'recording' ? 'denied' : 'allowed'),
    });
    await expect(g.evaluate(input)).resolves.toEqual({ allowed: false, denied_operation: 'recording' });
    expect(checkOperationForService).toHaveBeenCalledTimes(1); // short-circuits
  });

  it('recording allowed + transcription denied → denied_operation transcription', async () => {
    const { g } = gate({ talentIds: ['a'], consent: (op) => (op === 'transcription' ? 'denied' : 'allowed') });
    await expect(g.evaluate(input)).resolves.toEqual({ allowed: false, denied_operation: 'transcription' });
  });

  it('consent error → fail closed (treated as denied)', async () => {
    const { g } = gate({ talentIds: ['a'], consent: () => 'error' });
    await expect(g.evaluate(input)).resolves.toEqual({ allowed: false, denied_operation: 'recording' });
  });

  it('never checks ai_processing', async () => {
    const { g, checkOperationForService } = gate({ talentIds: ['a'], consent: () => 'allowed' });
    await g.evaluate(input);
    const ops = checkOperationForService.mock.calls.map((c) => (c[0] as { operation: string }).operation);
    expect(ops).toEqual(['recording', 'transcription']);
    expect(ops).not.toContain('ai_processing');
  });
});
