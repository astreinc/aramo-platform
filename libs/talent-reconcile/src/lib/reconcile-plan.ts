import type { EnrichmentPatch, TalentRecordView } from '@aramo/talent-record';
import type { EvidenceRecordRow } from '@aramo/talent-trust';

// Promotion Gate Slice-B1 — the PURE reconcile engine: given the current
// TalentRecord (L3 projection) + the subject's declared EvidenceRecords (L2
// history), compute the enrich patch (fill-null contact + append key_skills),
// the field→evidence provenance to record, and the pending contradictions.
// No IO — the service applies the plan. Deterministic (no LLM, no clock).
//
// Rules (directive §3.4 / §4.3-4):
//   - fill-null single-slot contact (email1/web_site/phone_cell/address block):
//     null → fill + provenance; occupied-same → provenance align (idempotent);
//     occupied-differing → pending contradiction (NEVER overwrite).
//   - key_skills: append the union of declared SKILL values (dormant until a
//     SKILL-evidence writer exists; never a contradiction — additive).
//   - identity-stable (first_name/last_name from FULL_NAME): never enriched;
//     same → provenance align; differing → pending contradiction.
//   - talent-stated / recruiter-owned / provenance fields: never touched (absent
//     from every map below).

export interface ReconcilePlan {
  patch: EnrichmentPatch;
  provenance: Array<{ field_name: string; evidence_id: string }>;
  contradictions: Array<{ field_name: string; new_evidence_id: string }>;
}

// Single-slot fill-null contact fields, keyed to the pipeline's real
// assertion_types (recon §1). current_employer/email2/phone_home/phone_work have
// no evidence writer today → deliberately omitted (no speculative slots).
const SINGLE_SLOT: ReadonlyArray<{
  field: keyof EnrichmentPatch & string;
  recordField: keyof TalentRecordView & string;
  assertionType: string;
  extract: (p: Record<string, unknown>) => string | undefined;
}> = [
  { field: 'email1', recordField: 'email1', assertionType: 'EMAIL', extract: (p) => str(p['normalized_value']) ?? str(p['value']) },
  { field: 'web_site', recordField: 'web_site', assertionType: 'PROFILE_URL', extract: (p) => str(p['value']) ?? str(p['normalized_value']) },
  { field: 'phone_cell', recordField: 'phone_cell', assertionType: 'PHONE', extract: (p) => str(p['value']) },
];

// ADDRESS carries several sub-fields on ONE EvidenceRecord — each fills its own
// null slot, all sharing the ADDRESS evidence's provenance.
const ADDRESS_SUB: ReadonlyArray<{
  field: keyof EnrichmentPatch & string;
  recordField: keyof TalentRecordView & string;
  key: string;
}> = [
  { field: 'address', recordField: 'address', key: 'address' },
  { field: 'address2', recordField: 'address2', key: 'address2' },
  { field: 'city', recordField: 'city', key: 'city' },
  { field: 'state', recordField: 'state', key: 'state' },
  { field: 'zip', recordField: 'zip', key: 'zip' },
];

export function computeReconcilePlan(
  record: TalentRecordView,
  evidence: EvidenceRecordRow[],
): ReconcilePlan {
  const plan: ReconcilePlan = { patch: {}, provenance: [], contradictions: [] };
  const newest = newestByType(evidence);

  for (const m of SINGLE_SLOT) {
    const ev = newest.get(m.assertionType);
    if (ev === undefined) continue;
    const value = m.extract(payloadOf(ev));
    if (value === undefined) continue;
    fillNull(plan, m.field, currentOf(record, m.recordField), value, ev.id);
  }

  const addr = newest.get('ADDRESS');
  if (addr !== undefined) {
    const p = payloadOf(addr);
    for (const s of ADDRESS_SUB) {
      const value = str(p[s.key]);
      if (value === undefined) continue;
      fillNull(plan, s.field, currentOf(record, s.recordField), value, addr.id);
    }
  }

  // Identity-stable — never enriched; align or flag.
  const name = newest.get('FULL_NAME');
  if (name !== undefined) {
    const p = payloadOf(name);
    identityStable(plan, 'first_name', currentOf(record, 'first_name'), str(p['first_name']), name.id);
    identityStable(plan, 'last_name', currentOf(record, 'last_name'), str(p['last_name']), name.id);
  }

  // key_skills — append the union of declared SKILL values (additive, never a
  // contradiction). Dormant until a SKILL-evidence writer exists.
  const skills = evidence
    .filter((e) => e.assertion_type === 'SKILL' && isLive(e))
    .sort(byCollectedAsc);
  if (skills.length > 0) {
    const declared = skills
      .map((e) => str(payloadOf(e)['value']) ?? str(payloadOf(e)['skill']))
      .filter((v): v is string => v !== undefined);
    const union = unionSkills(currentOf(record, 'key_skills'), declared);
    if (union.changed) {
      plan.patch.key_skills = union.value;
      const newestSkill = skills[skills.length - 1];
      if (newestSkill !== undefined) {
        plan.provenance.push({ field_name: 'key_skills', evidence_id: newestSkill.id });
      }
    }
  }

  return plan;
}

// ---- helpers ---------------------------------------------------------------

function fillNull(
  plan: ReconcilePlan,
  field: string,
  current: string | null,
  value: string,
  evidenceId: string,
): void {
  if (current === null) {
    (plan.patch as Record<string, string>)[field] = value;
    plan.provenance.push({ field_name: field, evidence_id: evidenceId });
  } else if (current === value) {
    // Occupied-same → align provenance (idempotent; back-fills promotion-created
    // fields on first reconcile).
    plan.provenance.push({ field_name: field, evidence_id: evidenceId });
  } else {
    // Occupied + newer-differing → NOT overwritten; recorded for B2.
    plan.contradictions.push({ field_name: field, new_evidence_id: evidenceId });
  }
}

function identityStable(
  plan: ReconcilePlan,
  field: string,
  current: string | null,
  value: string | undefined,
  evidenceId: string,
): void {
  if (value === undefined) return;
  if (current === value) {
    plan.provenance.push({ field_name: field, evidence_id: evidenceId });
  } else {
    plan.contradictions.push({ field_name: field, new_evidence_id: evidenceId });
  }
}

// Newest VALID EvidenceRecord per assertion_type (by collected_at, created_at
// tiebreak). Only VALID evidence projects (STALE/SUPERSEDED/REVOKED/CONTRADICTED
// are not live truth).
function newestByType(evidence: EvidenceRecordRow[]): Map<string, EvidenceRecordRow> {
  const out = new Map<string, EvidenceRecordRow>();
  for (const e of evidence) {
    if (!isLive(e)) continue;
    const prev = out.get(e.assertion_type);
    if (prev === undefined || byCollectedAsc(prev, e) < 0) out.set(e.assertion_type, e);
  }
  return out;
}

function byCollectedAsc(a: EvidenceRecordRow, b: EvidenceRecordRow): number {
  const ta = a.collected_at.getTime();
  const tb = b.collected_at.getTime();
  if (ta !== tb) return ta - tb;
  return a.created_at.getTime() - b.created_at.getTime();
}

function isLive(e: EvidenceRecordRow): boolean {
  return e.current_status === 'VALID';
}

function payloadOf(e: EvidenceRecordRow): Record<string, unknown> {
  return e.assertion_payload !== null && typeof e.assertion_payload === 'object'
    ? (e.assertion_payload as Record<string, unknown>)
    : {};
}

function currentOf(record: TalentRecordView, field: string): string | null {
  const v = (record as unknown as Record<string, unknown>)[field];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length === 0 ? undefined : t;
}

// Case-insensitive union-append of comma-joined skills, preserving current order
// and appending new declared skills. Returns changed=false when nothing new.
function unionSkills(
  current: string | null,
  declared: string[],
): { changed: boolean; value: string } {
  const existing = (current ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set(existing.map((s) => s.toLowerCase()));
  const merged = [...existing];
  for (const d of declared) {
    for (const one of d.split(',').map((s) => s.trim()).filter((s) => s.length > 0)) {
      if (!seen.has(one.toLowerCase())) {
        seen.add(one.toLowerCase());
        merged.push(one);
      }
    }
  }
  const value = merged.join(', ');
  return { changed: value !== (current ?? ''), value };
}
