import { describe, expect, it, vi } from 'vitest';

import { TalentExtractionService } from '../lib/talent-extraction.service.js';

// HF1 Gate-6 durable-provenance PERSISTENCE (rulings R1/R2/R3/R8). These prove
// the DETERMINISTIC persistence path — no AI call is ever made (R3) — stamps
// source_document_id + source_refs + source_map_version + resume_text_hash onto
// résumé-derived work-history AND skill evidence, and that the null-provenance
// path (pre-HF1 callers) still writes clean rows.

const TENANT = '01900000-0000-7000-8000-000000000001';
const TALENT = '01900000-0000-7000-8000-0000000000aa';

function makeService() {
  const createTalentWorkHistoryEntry = vi.fn().mockResolvedValue({ id: 'wh' });
  const createTalentSkillEvidence = vi.fn().mockResolvedValue({ id: 'sk' });
  const createTalentDocument = vi.fn().mockResolvedValue({ id: 'doc' });
  const evidence = {
    createTalentWorkHistoryEntry,
    createTalentSkillEvidence,
    createTalentDocument,
  };
  // The two model surfaces — MUST NEVER be called by the persistence path (R3).
  const generateDraft = vi.fn();
  const generateStructured = vi.fn();
  const svc = new TalentExtractionService(
    { generateDraft } as never,
    evidence as never,
    {} as never,
    { generateStructured, providerKey: () => 'anthropic' } as never,
  );
  return {
    svc,
    createTalentWorkHistoryEntry,
    createTalentSkillEvidence,
    createTalentDocument,
    generateDraft,
    generateStructured,
  };
}

const PROVENANCE = {
  source_document_id: 'doc-1',
  source_map_version: 'resume-source-map/v1',
  resume_text_hash: 'abc123',
};

describe('createResumeDocument — résumé TalentDocument at confirmed create (R1)', () => {
  it('creates a resume document and returns its id; no AI call', async () => {
    const { svc, createTalentDocument, generateDraft, generateStructured } = makeService();
    const id = await svc.createResumeDocument({
      talent_id: TALENT,
      tenant_id: TENANT,
      uploaded_by_actor_id: 'actor-1',
      storage_key: 's3/key/resume.pdf',
      filename: 'resume.pdf',
      mime_type: 'application/pdf',
      size_bytes: 12345,
    });
    expect(typeof id).toBe('string');
    expect(createTalentDocument).toHaveBeenCalledOnce();
    const arg = createTalentDocument.mock.calls[0][0];
    expect(arg.document_type).toBe('resume');
    expect(arg.file_storage_ref).toBe('s3/key/resume.pdf');
    expect(arg.parse_status).toBe('parsed');
    expect(arg.is_active).toBe(true);
    expect(arg.uploaded_by_actor_id).toBe('actor-1');
    expect(generateDraft).not.toHaveBeenCalled();
    expect(generateStructured).not.toHaveBeenCalled();
  });
});

describe('persistDeclaredWorkHistory — durable provenance (R8), deterministic (R3)', () => {
  it('stamps source_document_id + per-entry source_refs + version + hash', async () => {
    const { svc, createTalentWorkHistoryEntry, generateDraft, generateStructured } = makeService();
    await svc.persistDeclaredWorkHistory({
      talent_id: TALENT,
      tenant_id: TENANT,
      entries: [
        { employer_name: 'Northstar', role_title: 'Cloud Engineer', source_refs: ['B004', 'B004', 'B005'] },
      ],
      provenance: PROVENANCE,
    });
    expect(createTalentWorkHistoryEntry).toHaveBeenCalledOnce();
    const arg = createTalentWorkHistoryEntry.mock.calls[0][0];
    expect(arg.source).toBe('resume');
    expect(arg.source_document_id).toBe('doc-1');
    expect(arg.source_refs).toEqual(['B004', 'B005']); // de-duplicated, order kept
    expect(arg.source_map_version).toBe('resume-source-map/v1');
    expect(arg.resume_text_hash).toBe('abc123');
    // R3 — no model call in the persistence path.
    expect(generateDraft).not.toHaveBeenCalled();
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it('null-provenance path (pre-HF1 caller) writes clean rows — no provenance keys', async () => {
    const { svc, createTalentWorkHistoryEntry } = makeService();
    await svc.persistDeclaredWorkHistory({
      talent_id: TALENT,
      tenant_id: TENANT,
      entries: [{ employer_name: 'Acme', role_title: 'Engineer' }],
    });
    const arg = createTalentWorkHistoryEntry.mock.calls[0][0];
    expect(arg.source_document_id).toBeUndefined();
    expect(arg.source_map_version).toBeUndefined();
    expect(arg.resume_text_hash).toBeUndefined();
    expect(arg.source_refs).toBeUndefined(); // repo defaults to []
  });
});

describe('persistDeclaredSkills — declared skill evidence with provenance (R2/R3)', () => {
  it('persists de-duplicated declared skills with provenance; NEVER scored; no AI', async () => {
    const { svc, createTalentSkillEvidence, generateDraft, generateStructured } = makeService();
    const ids = await svc.persistDeclaredSkills({
      talent_id: TALENT,
      tenant_id: TENANT,
      skills: [
        { surface_form: 'C#', source_refs: ['B003'] },
        { surface_form: 'C#', source_refs: ['B003'] }, // duplicate → collapsed
        { surface_form: 'Azure SQL', source_refs: ['B003'] },
      ],
      provenance: PROVENANCE,
    });
    expect(ids).toHaveLength(2);
    expect(createTalentSkillEvidence).toHaveBeenCalledTimes(2);
    const first = createTalentSkillEvidence.mock.calls[0][0];
    expect(first.surface_form).toBe('C#');
    expect(first.source).toBe('declared');
    expect(first.source_document_id).toBe('doc-1');
    expect(first.source_refs).toEqual(['B003']);
    expect(first.source_map_version).toBe('resume-source-map/v1');
    expect(first.resume_text_hash).toBe('abc123');
    // Declared ≠ scored: no confidence.
    expect(first.confidence_score).toBeUndefined();
    // R3 — deterministic persistence, no model call.
    expect(generateDraft).not.toHaveBeenCalled();
    expect(generateStructured).not.toHaveBeenCalled();
  });
});
