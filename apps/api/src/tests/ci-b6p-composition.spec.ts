import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CI_PROCESSING_ERROR_CODES } from '@aramo/conversation-intelligence';
import type {
  ConversationIntelligenceModelProvider,
  ModelAnalysisInput,
  NormalizedTranscriptLoadResult,
  RequisitionSnapshotView,
} from '@aramo/conversation-intelligence';
import type { StructuredGenerationProvider, StructuredGenerationRequest } from '@aramo/ai-draft';

import { CiProcessingConfig, CiProcessingConfigError } from '../conversation-intelligence/ci-processing.config.js';
import { AnthropicConversationIntelligenceAdapter } from '../conversation-intelligence/anthropic-ci-model-provider.adapter.js';
import { B2RequisitionSnapshotSource } from '../conversation-intelligence/requisition-snapshot-source.adapter.js';
import { CiSnapshotResolver } from '../conversation-intelligence/ci-snapshot-resolver.js';
import { NormalizedTranscriptReadyHandler } from '../conversation-intelligence/normalized-transcript-ready.handler.js';
import { CiProcessingProcessor } from '../conversation-intelligence/ci-processing.processor.js';
import { CiProcessingReconciler } from '../conversation-intelligence/ci-processing-reconciler.js';
import {
  CI_PROCESSING_RECONCILE_JOB,
  CI_PROCESSING_RUN_JOB,
} from '../conversation-intelligence/ci-processing.queue.constants.js';

const noopLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

// ---------------------------------------------------------------- config
describe('CI-B6P CiProcessingConfig (activation + allowlist, fail-closed)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('disabled by default (absent env)', () => {
    delete process.env['CI_PROCESSING_ENABLED'];
    expect(new CiProcessingConfig().isEnabled()).toBe(false);
  });
  it('enabled only on exact "true"', () => {
    process.env['CI_PROCESSING_ENABLED'] = 'TRUE';
    expect(new CiProcessingConfig().isEnabled()).toBe(false);
    process.env['CI_PROCESSING_ENABLED'] = 'true';
    expect(new CiProcessingConfig().isEnabled()).toBe(true);
  });
  it('resolveModel fail-closed: missing → throws', () => {
    delete process.env['CI_ANTHROPIC_MODEL'];
    expect(() => new CiProcessingConfig().resolveModel()).toThrow(CiProcessingConfigError);
  });
  it('resolveModel fail-closed: non-allowlisted → throws (no fallback)', () => {
    process.env['CI_ANTHROPIC_MODEL'] = 'gpt-4o';
    expect(() => new CiProcessingConfig().resolveModel()).toThrow(CiProcessingConfigError);
  });
  it('resolveModel accepts an allowlisted model', () => {
    process.env['CI_ANTHROPIC_MODEL'] = 'claude-sonnet-4-6';
    expect(new CiProcessingConfig().resolveModel()).toBe('claude-sonnet-4-6');
  });
  it('isReady = enabled AND model valid', () => {
    process.env['CI_PROCESSING_ENABLED'] = 'true';
    process.env['CI_ANTHROPIC_MODEL'] = 'claude-sonnet-4-6';
    expect(new CiProcessingConfig().isReady()).toBe(true);
    process.env['CI_ANTHROPIC_MODEL'] = 'bad';
    expect(new CiProcessingConfig().isReady()).toBe(false);
    process.env['CI_PROCESSING_ENABLED'] = 'false';
    process.env['CI_ANTHROPIC_MODEL'] = 'claude-sonnet-4-6';
    expect(new CiProcessingConfig().isReady()).toBe(false);
  });
});

// ---------------------------------------------------------- snapshot source
describe('CI-B6P B2RequisitionSnapshotSource', () => {
  it('maps the B2 view to the narrow CI view; null passthrough', async () => {
    const svc = {
      getSnapshot: vi.fn(async () => ({
        id: 's1',
        tenant_id: 't',
        requisition_id: 'r',
        source_requisition_version: 3,
        golden_profile_id: null,
        snapshot_schema_version: 'v1',
        context: { role: 'x' },
        captured_at: new Date(0),
        created_at: new Date(0),
      })),
    };
    const out = (await new B2RequisitionSnapshotSource(svc as never).getSnapshot('t', 's1')) as RequisitionSnapshotView;
    expect(out).toEqual({ id: 's1', source_requisition_version: 3, context: { role: 'x' } });

    const nullSvc = { getSnapshot: vi.fn(async () => null) };
    expect(await new B2RequisitionSnapshotSource(nullSvc as never).getSnapshot('t', 'x')).toBeNull();
  });
});

// -------------------------------------------------- anthropic CI adapter
function adapterWith(genImpl: StructuredGenerationProvider['generateStructured']) {
  process.env['CI_PROCESSING_ENABLED'] = 'true';
  process.env['CI_ANTHROPIC_MODEL'] = 'claude-sonnet-4-6';
  const gen: StructuredGenerationProvider = { providerKey: () => 'anthropic', generateStructured: genImpl };
  return new AnthropicConversationIntelligenceAdapter(gen, new CiProcessingConfig());
}
const MODEL_INPUT: ModelAnalysisInput = {
  tenant_id: 't',
  conversation_transcript_id: 'cx',
  normalized_transcript: {
    conversation_transcript_id: 'cx',
    tenant_id: 't',
    interaction_id: 'ix',
    normalized_sha256: 'a'.repeat(64),
    utterances: [
      { utterance_id: 'utt_1', ordinal: 0, speaker_role: 'RECRUITER', start_ms: 10, end_ms: 20, text: 'hello' },
    ],
  },
  requisition_context: { role: 'engineer' },
  prompt_template_id: 'conversation-intelligence.analysis',
  prompt_template_version: 'v1',
  prompt_sha256: 'b'.repeat(64),
  output_schema_version: 'conversation-intelligence.analysis.v1',
};

describe('CI-B6P AnthropicConversationIntelligenceAdapter', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it('providerKey + modelIdentity come from the generation surface + config', () => {
    const a = adapterWith(async () => ({ kind: 'ok', parsed: {}, transport: { model_used: 'm', input_tokens: 1, output_tokens: 1 } }));
    expect(a.providerKey()).toBe('anthropic');
    expect(a.modelIdentity()).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  it('MINIMIZED input: only utterance_id/speaker_role/text + requisition_context (no timing/names)', async () => {
    let captured: StructuredGenerationRequest | null = null;
    const a = adapterWith(async (req) => {
      captured = req;
      return { kind: 'ok', parsed: { ok: 1 }, transport: { model_used: 'claude-sonnet-4-6', input_tokens: 1, output_tokens: 1, provider_request_id: 'rid' } };
    });
    const out = await a.generateStructuredAnalysis(MODEL_INPUT);
    expect(out).toEqual({ kind: 'ok', raw_result: { ok: 1 }, model_request_id: 'rid' });
    const payload = JSON.parse((captured as unknown as StructuredGenerationRequest).user_content) as Record<string, unknown>;
    const utt = (payload['transcript'] as { utterances: Record<string, unknown>[] }).utterances[0]!;
    expect(Object.keys(utt).sort()).toEqual(['speaker_role', 'text', 'utterance_id']);
    expect(utt['start_ms']).toBeUndefined();
    expect(payload['requisition_context']).toEqual({ role: 'engineer' });
  });

  it('maps retryable/terminal provider outcomes to the B6 taxonomy', async () => {
    const retry = await adapterWith(async () => ({ kind: 'retryable', category: 'rate_limited' })).generateStructuredAnalysis(MODEL_INPUT);
    expect(retry).toEqual({ kind: 'retryable_failure', error_code: CI_PROCESSING_ERROR_CODES.MODEL_RATE_LIMITED });
    const term = await adapterWith(async () => ({ kind: 'terminal', category: 'auth_config' })).generateStructuredAnalysis(MODEL_INPUT);
    expect(term).toEqual({ kind: 'terminal_failure', error_code: CI_PROCESSING_ERROR_CODES.MODEL_PROVIDER_UNAVAILABLE });
  });
});

// ------------------------------------------------------- snapshot resolver
describe('CI-B6P CiSnapshotResolver (reuse-latest / capture)', () => {
  it('reuses the latest existing snapshot (no capture)', async () => {
    const svc = {
      listSnapshotsForRequisition: vi.fn(async () => [
        { id: 'old', source_requisition_version: 1, captured_at: new Date(1) },
        { id: 'new', source_requisition_version: 2, captured_at: new Date(2) },
      ]),
      captureSnapshot: vi.fn(),
    };
    const id = await new CiSnapshotResolver(svc as never).resolveSnapshotId('t', 'r');
    expect(id).toBe('new');
    expect(svc.captureSnapshot).not.toHaveBeenCalled();
  });
  it('captures when none exists', async () => {
    const svc = {
      listSnapshotsForRequisition: vi.fn(async () => []),
      captureSnapshot: vi.fn(async () => ({ id: 'fresh' })),
    };
    const id = await new CiSnapshotResolver(svc as never).resolveSnapshotId('t', 'r');
    expect(id).toBe('fresh');
    expect(svc.captureSnapshot).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: 't', requisition_id: 'r' }));
  });
});

// ----------------------------------------------- normalized-ready handler
function readyLoad(): NormalizedTranscriptLoadResult {
  return {
    status: 'ready',
    view: {
      conversation_transcript_id: 'cx',
      tenant_id: 't',
      interaction_id: 'ix',
      normalized_sha256: 'a'.repeat(64),
      utterances: [{ utterance_id: 'utt_1', ordinal: 0, speaker_role: 'RECRUITER', text: 'hi' }],
    },
  };
}
function handlerSetup(opts: {
  enabled?: boolean;
  ready?: boolean;
  load?: NormalizedTranscriptLoadResult;
  talent?: string[];
  requisition?: string[];
}) {
  const config = {
    isEnabled: () => opts.enabled ?? true,
    isReady: () => opts.ready ?? true,
  } as unknown as CiProcessingConfig;
  const transcripts = { load: vi.fn(async () => opts.load ?? readyLoad()) };
  const comms = {
    findTalentSubjectIdsForInteraction: vi.fn(async () => opts.talent ?? ['tal_1']),
    findRequisitionIdsForInteraction: vi.fn(async () => opts.requisition ?? ['req_1']),
  };
  const snapshotResolver = { resolveSnapshotId: vi.fn(async () => 'snap_1') };
  const runs = { createOrGetQueued: vi.fn(async () => ({ id: 'run_1' })) };
  const model: ConversationIntelligenceModelProvider = {
    providerKey: () => 'anthropic',
    modelIdentity: () => ({ provider: 'anthropic', model: 'claude-sonnet-4-6' }),
    generateStructuredAnalysis: vi.fn(),
  };
  const producer = { enqueueRun: vi.fn(async () => undefined) };
  const handler = new NormalizedTranscriptReadyHandler(
    config,
    transcripts as never,
    comms as never,
    snapshotResolver as never,
    runs as never,
    model,
    producer as never,
    noopLogger,
  );
  return { handler, comms, runs, producer, model };
}

describe('CI-B6P NormalizedTranscriptReadyHandler (scheduling; NO model call)', () => {
  it('activation disabled → no run, no enqueue, no model call', async () => {
    const { handler, runs, producer, model } = handlerSetup({ enabled: false });
    expect(await handler.schedule({ tenant_id: 't', conversation_transcript_id: 'cx' })).toEqual({ scheduled: false, reason: 'disabled' });
    expect(runs.createOrGetQueued).not.toHaveBeenCalled();
    expect(producer.enqueueRun).not.toHaveBeenCalled();
    expect(model.generateStructuredAnalysis).not.toHaveBeenCalled();
  });
  it('config invalid → not scheduled', async () => {
    const { handler, runs } = handlerSetup({ ready: false });
    expect((await handler.schedule({ tenant_id: 't', conversation_transcript_id: 'cx' })).reason).toBe('config_invalid');
    expect(runs.createOrGetQueued).not.toHaveBeenCalled();
  });
  it('transcript not ready → not scheduled', async () => {
    const { handler } = handlerSetup({ load: { status: 'not_ready' } });
    expect((await handler.schedule({ tenant_id: 't', conversation_transcript_id: 'cx' })).reason).toBe('transcript_not_ready');
  });
  it('zero talent → no_talent; ambiguous talent → ambiguous_talent (no run)', async () => {
    const zero = handlerSetup({ talent: [] });
    expect((await zero.handler.schedule({ tenant_id: 't', conversation_transcript_id: 'cx' })).reason).toBe('no_talent');
    expect(zero.runs.createOrGetQueued).not.toHaveBeenCalled();
    const amb = handlerSetup({ talent: ['a', 'b'] });
    expect((await amb.handler.schedule({ tenant_id: 't', conversation_transcript_id: 'cx' })).reason).toBe('ambiguous_talent');
  });
  it('zero requisition → no_requisition; ambiguous → ambiguous_requisition (no run)', async () => {
    const zero = handlerSetup({ requisition: [] });
    expect((await zero.handler.schedule({ tenant_id: 't', conversation_transcript_id: 'cx' })).reason).toBe('no_requisition');
    expect(zero.runs.createOrGetQueued).not.toHaveBeenCalled();
    const amb = handlerSetup({ requisition: ['a', 'b'] });
    expect((await amb.handler.schedule({ tenant_id: 't', conversation_transcript_id: 'cx' })).reason).toBe('ambiguous_requisition');
  });
  it('happy path → durable run created BEFORE enqueue; identifiers only', async () => {
    const { handler, runs, producer } = handlerSetup({});
    const res = await handler.schedule({ tenant_id: 't', conversation_transcript_id: 'cx' });
    expect(res).toEqual({ scheduled: true, reason: 'queued', run_id: 'run_1' });
    expect(runs.createOrGetQueued).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 't', conversation_transcript_id: 'cx', requisition_analysis_context_snapshot_id: 'snap_1', model_name: 'claude-sonnet-4-6' }),
    );
    expect(producer.enqueueRun).toHaveBeenCalledWith('run_1', 't');
  });
});

// --------------------------------------------------------------- processor
function processorSetup(opts: { isReady?: boolean; isEnabled?: boolean; runStatus?: string | null }) {
  const config = { isReady: () => opts.isReady ?? true, isEnabled: () => opts.isEnabled ?? true } as unknown as CiProcessingConfig;
  const runs = {
    findRunByIdInTenant: vi.fn(async () =>
      opts.runStatus === null ? null : { id: 'run_1', tenant_id: 't', conversation_transcript_id: 'cx', requisition_analysis_context_snapshot_id: 's', status: opts.runStatus ?? 'queued' },
    ),
  };
  const processing = { process: vi.fn(async () => ({ outcome: 'completed' })) };
  const producer = { scheduleReconcile: vi.fn(), enqueueRun: vi.fn() };
  const reconciler = { reconcile: vi.fn(async () => ({ reEnqueued: 0 })) };
  const registrar = { register: vi.fn() };
  const redisConfig = { isConfigured: true } as never;
  const proc = new CiProcessingProcessor(config, runs as never, processing as never, producer as never, reconciler as never, registrar as never, redisConfig, noopLogger);
  return { proc, processing, reconciler, runs };
}

describe('CI-B6P CiProcessingProcessor (worker gating)', () => {
  it('reconcile job → reconciler.reconcile (no run processing)', async () => {
    const { proc, reconciler, processing } = processorSetup({});
    await proc.process({ name: CI_PROCESSING_RECONCILE_JOB, data: {} } as never);
    expect(reconciler.reconcile).toHaveBeenCalled();
    expect(processing.process).not.toHaveBeenCalled();
  });
  it('run job while not ready (disabled/misconfig) → no process() call', async () => {
    const { proc, processing } = processorSetup({ isReady: false, isEnabled: false });
    await proc.process({ name: CI_PROCESSING_RUN_JOB, data: { run_id: 'run_1', tenant_id: 't' } } as never);
    expect(processing.process).not.toHaveBeenCalled();
  });
  it('terminal run → short-circuit (idempotent; no re-process)', async () => {
    const { proc, processing } = processorSetup({ runStatus: 'completed' });
    await proc.process({ name: CI_PROCESSING_RUN_JOB, data: { run_id: 'run_1', tenant_id: 't' } } as never);
    expect(processing.process).not.toHaveBeenCalled();
  });
  it('non-terminal run → delegates to processing.process', async () => {
    const { proc, processing } = processorSetup({ runStatus: 'queued' });
    await proc.process({ name: CI_PROCESSING_RUN_JOB, data: { run_id: 'run_1', tenant_id: 't' } } as never);
    expect(processing.process).toHaveBeenCalledWith({ tenant_id: 't', conversation_transcript_id: 'cx', requisition_analysis_context_snapshot_id: 's' });
  });
});

// -------------------------------------------------------------- reconciler
describe('CI-B6P CiProcessingReconciler (bounded recovery)', () => {
  it('re-enqueues each re-drivable run', async () => {
    const runs = { listReDrivableRuns: vi.fn(async () => [{ id: 'r1', tenant_id: 't1' }, { id: 'r2', tenant_id: 't2' }]) };
    const producer = { enqueueRun: vi.fn(async () => undefined) };
    const out = await new CiProcessingReconciler(runs as never, producer as never, noopLogger).reconcile();
    expect(out).toEqual({ reEnqueued: 2 });
    expect(producer.enqueueRun).toHaveBeenCalledWith('r1', 't1');
    expect(producer.enqueueRun).toHaveBeenCalledWith('r2', 't2');
  });
});
