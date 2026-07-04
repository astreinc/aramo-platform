import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';

import {
  ColdIngestExtractionService,
  buildDeclaredIdentityEntries,
} from '../lib/cold-ingest-extraction.service.js';

// Unit coverage for the extraction seam:
//   - buildDeclaredIdentityEntries: the pure prefill → declared-evidence map
//     (name / phone / address → IDENTITY; trims + prunes; email/skills excluded).
//   - ColdIngestExtractionService.extractArrival: the three outcomes
//     (extracted / done_no_identity / transient_retry) and their marker calls.

const PAYLOAD_ID = 'payload-1';

function makeArrival(overrides: Partial<{ id: string; tenant_id: string; storage_ref: string; resolved_subject_id: string }> = {}) {
  return {
    id: PAYLOAD_ID,
    tenant_id: 'tenant-1',
    storage_ref: 's3://raw/tenant-1/resume.pdf',
    resolved_subject_id: 'subject-1',
    ...overrides,
  };
}

function makeService(parts: {
  parse?: ReturnType<typeof vi.fn>;
  record?: ReturnType<typeof vi.fn>;
  markDone?: ReturnType<typeof vi.fn>;
  bump?: ReturnType<typeof vi.fn>;
}) {
  const parseFromStorageKey = parts.parse ?? vi.fn();
  const recordDeclaredEvidenceForSubject =
    parts.record ?? vi.fn().mockResolvedValue({ evidence_ids: [] });
  const markExtractionDone = parts.markDone ?? vi.fn().mockResolvedValue(undefined);
  const bumpExtractionAttempt = parts.bump ?? vi.fn().mockResolvedValue(undefined);

  const ingestionRepo = {
    markExtractionDone,
    bumpExtractionAttempt,
  } as never;
  const resumeParser = { parseFromStorageKey } as never;
  const talentTrust = { recordDeclaredEvidenceForSubject } as never;
  const logger = { log: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;

  const service = new ColdIngestExtractionService(ingestionRepo, resumeParser, talentTrust, logger);
  return { service, parseFromStorageKey, recordDeclaredEvidenceForSubject, markExtractionDone, bumpExtractionAttempt };
}

describe('buildDeclaredIdentityEntries — pure prefill → declared IDENTITY evidence', () => {
  it('maps first/last name to a single FULL_NAME IDENTITY entry (trimmed)', () => {
    const entries = buildDeclaredIdentityEntries(
      { first_name: '  Ada ', last_name: 'Lovelace' },
      PAYLOAD_ID,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      dimension: 'IDENTITY',
      assertion_type: 'FULL_NAME',
      assertion_payload: { first_name: 'Ada', last_name: 'Lovelace', payload_id: PAYLOAD_ID },
    });
  });

  it('emits FULL_NAME with only the present name part', () => {
    const entries = buildDeclaredIdentityEntries({ first_name: 'Grace' }, PAYLOAD_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.assertion_payload).toEqual({ first_name: 'Grace', payload_id: PAYLOAD_ID });
  });

  it('picks phone in cell → home → work precedence', () => {
    const entries = buildDeclaredIdentityEntries(
      { first_name: 'A', phone_home: '111', phone_work: '222' },
      PAYLOAD_ID,
    );
    const phone = entries.find((e) => e.assertion_type === 'PHONE');
    expect(phone?.assertion_payload).toEqual({ value: '111', payload_id: PAYLOAD_ID });

    const cell = buildDeclaredIdentityEntries(
      { first_name: 'A', phone_cell: '999', phone_home: '111' },
      PAYLOAD_ID,
    ).find((e) => e.assertion_type === 'PHONE');
    expect(cell?.assertion_payload).toEqual({ value: '999', payload_id: PAYLOAD_ID });
  });

  it('composes an ADDRESS entry from any present address part, pruning undefined', () => {
    const entries = buildDeclaredIdentityEntries(
      { city: 'London', zip: 'EC1' },
      PAYLOAD_ID,
    );
    const address = entries.find((e) => e.assertion_type === 'ADDRESS');
    expect(address?.assertion_payload).toEqual({ city: 'London', zip: 'EC1', payload_id: PAYLOAD_ID });
  });

  it('returns [] when the prefill has no name / phone / address (e.g. failed parse)', () => {
    expect(buildDeclaredIdentityEntries({}, PAYLOAD_ID)).toEqual([]);
    // Whitespace-only fields are treated as absent.
    expect(buildDeclaredIdentityEntries({ first_name: '   ', last_name: '' }, PAYLOAD_ID)).toEqual([]);
  });

  it('never emits EMAIL or SKILL entries (email is the arrival contact evidence; skills stay with ingestion)', () => {
    const entries = buildDeclaredIdentityEntries(
      { first_name: 'A', email1: 'a@b.com', key_skills: 'Go, Rust', current_employer: 'Acme' },
      PAYLOAD_ID,
    );
    const types = entries.map((e) => e.assertion_type);
    expect(types).not.toContain('EMAIL');
    expect(types).not.toContain('SKILL');
    expect(types).toEqual(['FULL_NAME']);
  });
});

describe('ColdIngestExtractionService.extractArrival — outcomes + marker calls', () => {
  it('extracted: writes declared evidence then stamps done', async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ prefill: { first_name: 'Ada', last_name: 'Lovelace' }, parse_status: 'parsed' });
    const { service, recordDeclaredEvidenceForSubject, markExtractionDone, bumpExtractionAttempt } =
      makeService({ parse });

    const result = await service.extractArrival(makeArrival());

    expect(result.outcome).toBe('extracted');
    expect(result.entry_count).toBe(1);
    expect(recordDeclaredEvidenceForSubject).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 'tenant-1', subject_id: 'subject-1' }),
    );
    expect(markExtractionDone).toHaveBeenCalledWith(PAYLOAD_ID);
    expect(bumpExtractionAttempt).not.toHaveBeenCalled();
  });

  it('done_no_identity: parsed but no name/phone/address → stamps done, writes nothing', async () => {
    const parse = vi.fn().mockResolvedValue({ prefill: {}, parse_status: 'failed' });
    const { service, recordDeclaredEvidenceForSubject, markExtractionDone } = makeService({ parse });

    const result = await service.extractArrival(makeArrival());

    expect(result.outcome).toBe('done_no_identity');
    expect(recordDeclaredEvidenceForSubject).not.toHaveBeenCalled();
    expect(markExtractionDone).toHaveBeenCalledWith(PAYLOAD_ID);
  });

  it('transient_retry: a parse throw bumps the attempt and leaves the gate NULL (no markDone)', async () => {
    const parse = vi
      .fn()
      .mockRejectedValue(new AramoError('OBJECT_STORAGE_UPLOAD_FAILED', 'fetch failed', 502));
    const { service, recordDeclaredEvidenceForSubject, markExtractionDone, bumpExtractionAttempt } =
      makeService({ parse });

    const result = await service.extractArrival(makeArrival());

    expect(result.outcome).toBe('transient_retry');
    expect(bumpExtractionAttempt).toHaveBeenCalledWith(PAYLOAD_ID);
    expect(markExtractionDone).not.toHaveBeenCalled();
    expect(recordDeclaredEvidenceForSubject).not.toHaveBeenCalled();
  });

  it('never throws — a transient failure resolves to a counted outcome, not a rejection', async () => {
    const parse = vi.fn().mockRejectedValue(new Error('boom'));
    const { service } = makeService({ parse });
    await expect(service.extractArrival(makeArrival())).resolves.toMatchObject({
      outcome: 'transient_retry',
    });
  });
});
