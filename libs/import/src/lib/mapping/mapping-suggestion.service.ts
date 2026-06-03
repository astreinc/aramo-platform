import { Injectable } from '@nestjs/common';

import type { ImportTargetEntity } from '../dto/import-target-entity.js';
import type {
  SuggestMappingResponseDto,
  SuggestedFieldMapping,
  FieldReferenceDoc,
  SourceColumnSamples,
  MappingConfidence,
  MappingReason,
} from '../dto/suggest-mapping-response.dto.js';

import { DATA_SHAPE_THRESHOLD, inferDataShape } from './data-shape-patterns.js';
import { getFieldCatalog, normalizeHeader } from './field-catalog.js';

// PR-A8-2 — the deterministic mapping-suggestion service. THE Lead
// design ruling (ADR-0015): the inference is a DETERMINISTIC HEURISTIC
// (header-synonym + data-shape sampling), NOT an LLM call. Same
// (target, headers, sample_rows) input → IDENTICAL output every time.
// No DB, no network, no Anthropic SDK, no ai-draft import — the
// no-LLM-boundary spec asserts this structurally.
//
// Algorithm (the §2 design):
//   1. For each target field × each source header, compute the
//      strongest match using two signals:
//        a. SYNONYM — header normalized matches a synonym in the
//           field's catalog entry → confidence HIGH (weight 100).
//        b. SUBSTRING — field name (normalized) appears inside the
//           normalized header, or a synonym appears as substring
//           (handles "Email Address" → 'email1') → confidence MEDIUM
//           (weight 60).
//        c. DATA-SHAPE — sampling the column's values, the inferred
//           type matches the field's catalog type → confidence by
//           match-rate (HIGH if ≥ 0.8, MEDIUM if 0.5-0.8) (weight
//           up to 40, intentionally below substring-synonym; the
//           Lead's call: synonym signals beat shape signals).
//   2. Assemble all (field, header, weight, confidence, reason)
//      match-options. Sort by:
//        a. weight DESC,
//        b. required-field FIRST (required beats optional on ties so
//           a required field wins the column),
//        c. field-name ASC (deterministic tiebreak).
//   3. Greedy-assign: walk the sorted matches, claiming a (field,
//      header) pair iff NEITHER side has been claimed yet. No double-
//      binding (one source column → at most one target field).
//   4. Unclaimed target fields get { source_column: null,
//      confidence: 'none', reason: 'unmatched' }; required ones are
//      surfaced separately in `unmatched_required_fields` for the UI.

const HIGH_SHAPE_RATE = 0.8;

type MatchOption = {
  field: string;
  header: string;
  weight: number;
  confidence: MappingConfidence;
  reason: MappingReason;
};

@Injectable()
export class MappingSuggestionService {
  suggest(args: {
    target_entity: ImportTargetEntity;
    headers: readonly string[];
    sample_rows: ReadonlyArray<Record<string, unknown>>;
  }): SuggestMappingResponseDto {
    const { target_entity, headers, sample_rows } = args;
    const catalog = getFieldCatalog(target_entity);

    // Normalize headers once; preserve the original-string form so
    // the response's source_column field is the user's exact header
    // (the UI displays it back; the user's confirmed mapping uses it
    // as the key in ConfirmedMapping).
    const normalizedHeaders = headers.map((h) => ({
      original: h,
      normalized: normalizeHeader(h),
      samples: sample_rows.map((row) => row[h]),
    }));

    const matches: MatchOption[] = [];

    for (const entry of catalog) {
      const normalizedField = normalizeHeader(entry.field);
      const synonyms = new Set(entry.synonyms);
      for (const h of normalizedHeaders) {
        const synonymHit = synonyms.has(h.normalized);
        if (synonymHit) {
          matches.push({
            field: entry.field,
            header: h.original,
            weight: 100,
            confidence: 'high',
            reason: 'synonym',
          });
          continue;
        }
        // SUBSTRING — field-name-in-header or synonym-in-header (or
        // header-in-field-name, e.g. "Phone" header for phone_work).
        // Only when the field has synonyms (FK fields with empty
        // synonym sets stay out of substring matching too — they're
        // system-resolved).
        if (synonyms.size > 0) {
          let substringHit = false;
          if (h.normalized.includes(normalizedField) || normalizedField.includes(h.normalized)) {
            substringHit = true;
          } else {
            for (const syn of synonyms) {
              if (h.normalized.includes(syn) || syn.includes(h.normalized)) {
                substringHit = true;
                break;
              }
            }
          }
          if (substringHit) {
            matches.push({
              field: entry.field,
              header: h.original,
              weight: 60,
              confidence: 'medium',
              reason: 'synonym',
            });
            continue;
          }
        }
        // DATA-SHAPE — sample the values under this header; if the
        // inferred type matches the field's catalog type, weight by
        // match rate.
        const shape = inferDataShape(h.samples);
        if (shape !== null && shape.matchedType === entry.type) {
          const shapeConfidence: MappingConfidence =
            shape.rate >= HIGH_SHAPE_RATE ? 'high' : 'medium';
          matches.push({
            field: entry.field,
            header: h.original,
            // up to 40 — intentionally lower than substring synonym
            weight: Math.round(shape.rate * 40),
            confidence: shapeConfidence,
            reason: 'data-shape',
          });
        }
      }
    }

    // Deterministic sort — weight DESC, required FIRST, field ASC,
    // header ASC. The catalog order is read into a name→required map
    // for the second criterion.
    const requiredMap = new Map<string, boolean>(
      catalog.map((e) => [e.field, e.required]),
    );
    matches.sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      const aReq = requiredMap.get(a.field) ?? false;
      const bReq = requiredMap.get(b.field) ?? false;
      if (aReq !== bReq) return aReq ? -1 : 1;
      if (a.field !== b.field) return a.field < b.field ? -1 : 1;
      return a.header < b.header ? -1 : 1;
    });

    // Greedy assignment — first wins.
    const fieldToHeader = new Map<string, MatchOption>();
    const claimedHeaders = new Set<string>();
    for (const m of matches) {
      if (fieldToHeader.has(m.field)) continue;
      if (claimedHeaders.has(m.header)) continue;
      fieldToHeader.set(m.field, m);
      claimedHeaders.add(m.header);
    }

    // Build SuggestedFieldMapping list in catalog order (stable).
    const suggestions: SuggestedFieldMapping[] = catalog.map((entry) => {
      const claimed = fieldToHeader.get(entry.field);
      if (claimed === undefined) {
        return {
          field: entry.field,
          suggested_source_column: null,
          confidence: 'none',
          reason: 'unmatched',
        };
      }
      return {
        field: entry.field,
        suggested_source_column: claimed.header,
        confidence: claimed.confidence,
        reason: claimed.reason,
      };
    });

    const unmatched_required_fields = catalog
      .filter((e) => e.required && fieldToHeader.get(e.field) === undefined)
      .map((e) => e.field);

    // Reference-docs (the response section the UI consumes to show
    // each field's expected shape next to its suggestion).
    const reference_docs: FieldReferenceDoc[] = catalog.map((entry) => ({
      field: entry.field,
      type: entry.type,
      required: entry.required,
      example: entry.example,
      // synonyms exposed (clipped) — useful for the UI to suggest
      // alternative column names to the user. Empty arrays for FK
      // fields remain empty.
      accepted_synonyms: [...entry.synonyms],
    }));

    // Per-source-column samples (clipped at SAMPLE_DISPLAY_LIMIT so
    // the response stays bounded; the inference itself uses all
    // samples passed in).
    const SAMPLE_DISPLAY_LIMIT = 5;
    const samples: SourceColumnSamples[] = normalizedHeaders.map((h) => {
      const collected: Array<string | null> = [];
      for (const v of h.samples) {
        if (v === null || v === undefined) collected.push(null);
        else collected.push(String(v));
        if (collected.length >= SAMPLE_DISPLAY_LIMIT) break;
      }
      return {
        source_column: h.original,
        sample_values: collected,
      };
    });

    return {
      target_entity,
      suggestions,
      unmatched_required_fields,
      reference_docs,
      samples,
      // Echo the threshold for transparency — the UI can show
      // "data-shape confidence ≥ 50% required."
      data_shape_threshold: DATA_SHAPE_THRESHOLD,
    };
  }
}
