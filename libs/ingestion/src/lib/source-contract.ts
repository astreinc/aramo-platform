// TM-L1-A — Source / Channel Contract (canonical, code-owned).
//
// ONE provider-neutral definition of the ingestion source/channel contract for
// Lane 1. Before TM-L1-A the accepted-source vocabulary lived hand-maintained in
// THREE independent places that could silently drift apart:
//   1. INGESTION_SOURCES        (the wire allowlist on the request DTO)
//   2. CHANNEL_SOURCE_CLASS     (the source -> source_class map)
//   3. openapi/ingestion.yaml   (the IngestionSource enum)
// This module is the single structure the first two now DERIVE from; the third
// is held in lockstep by a parity test (source-contract.spec.ts). Adding or
// removing a source is a one-place code change here that the parity test forces
// to ripple to the OpenAPI enum — drift becomes a failing build, not a latent
// hazard.
//
// It is a CODE contract, not a runtime DB table (DDR-1 §3.1 precedent): a table
// would add an unauditable runtime mutation surface to an identity-critical,
// security-load-bearing decision. Every accepted value, its meaning, its
// attestation level, and its lifecycle status is git-versioned and reviewable.
//
// SCOPE DISCIPLINE (TM-L1-A): this contract carries ONLY sources whose producer
// is implemented and authorized today. It invents NO speculative future values
// (career-site / VMS / agency / social / partner earn a value when their adapter
// lands, not before). A future source is added by an explicit entry here plus
// its tests — never by omission or by widening the allowlist ahead of a producer.

// The arrival's attestation LEVEL — server-derived, NEVER caller-supplied
// (see deriveSourceClass). Mirrors talent_trust SourceClass but is declared
// LOCALLY so libs/ingestion takes no cross-lib import edge (DDR-1 §5). Today's
// channels emit only SELF / THIRD_PARTY_UNVERIFIED (the derivable set). A
// confirming level ('THIRD_PARTY_VERIFIED' in talent_trust) is RESERVED for a
// future channel whose documented semantics attest verification, and is added by
// an explicit contract entry landing WITH its producer — no dead vocabulary is
// minted in this union.
export type IngestionSourceClass = 'SELF' | 'THIRD_PARTY_UNVERIFIED';

// Lifecycle status of a contract entry. `current` = accepted at the wire today.
// `reserved` = a documented-but-NOT-accepted future value (there are none today;
// the axis exists so a later adapter can land its value as `reserved` before its
// producer is authorized without that value being wire-accepted). INGESTION_SOURCES
// derives from `current` entries only — a `reserved` entry is documented but is
// NOT in the closed allowlist and is rejected at the wire.
export type IngestionSourceStatus = 'current' | 'reserved';

export interface SourceContractEntry {
  // The wire/channel identifier (provider-neutral token).
  readonly source: string;
  // Server-derived attestation level for arrivals on this channel.
  readonly source_class: IngestionSourceClass;
  // Whether this value is wire-accepted today (`current`) or documented-only.
  readonly status: IngestionSourceStatus;
  // Human-auditable meaning: what an arrival on this channel represents. This is
  // channel/source IDENTITY (where the arrival came from) — distinct from
  // source_class (attestation level), from caller CLAIMS (declared_name,
  // verified_email), and from identity resolution (Lane 2, out of scope here).
  readonly meaning: string;
}

// The closed contract. Insertion order defines the canonical wire-enum order
// (talent_direct, indeed, github, astre_import) mirrored in openapi/ingestion.yaml.
//
// DDR-1 §4 verbatim: talent_direct is a first-party declaration (SELF); indeed /
// github / astre_import carry unverified third-party claims (THIRD_PARTY_UNVERIFIED).
export const INGESTION_SOURCE_CONTRACT = [
  {
    source: 'talent_direct',
    source_class: 'SELF',
    status: 'current',
    meaning:
      'First-party self-declaration: the Talent submitted the payload directly (self-signup / direct capture).',
  },
  {
    source: 'indeed',
    source_class: 'THIRD_PARTY_UNVERIFIED',
    status: 'current',
    meaning:
      'Indeed channel arrival (search-results shortlist / Apply intake). An unverified third-party claim; any verification attestation lives on the Indeed Apply producer, not on the arrival itself.',
  },
  {
    source: 'github',
    source_class: 'THIRD_PARTY_UNVERIFIED',
    status: 'current',
    meaning:
      'GitHub-channel arrival. An unverified third-party claim.',
  },
  {
    source: 'astre_import',
    source_class: 'THIRD_PARTY_UNVERIFIED',
    status: 'current',
    meaning:
      'Bulk/administrative import channel (harness-tenant onboarding). An unverified third-party claim.',
  },
] as const satisfies readonly SourceContractEntry[];

export type IngestionSource =
  (typeof INGESTION_SOURCE_CONTRACT)[number]['source'];

// The closed wire allowlist — DERIVED from the `current` contract entries, never
// hand-maintained alongside them. This is what the request DTO's @IsIn() closes
// over (R7 Layer 1 structural refusal) and what the OpenAPI IngestionSource enum
// is held equal to by the parity test.
export const INGESTION_SOURCES: readonly IngestionSource[] = Object.freeze(
  INGESTION_SOURCE_CONTRACT.filter((e) => e.status === 'current').map(
    (e) => e.source,
  ) as IngestionSource[],
);

// Internal lookup, built once from the same contract literal so the allowlist
// and the source_class mapping CANNOT diverge — they are two projections of one
// structure.
const SOURCE_CLASS_BY_SOURCE: Readonly<Record<string, IngestionSourceClass>> =
  Object.freeze(
    Object.fromEntries(
      INGESTION_SOURCE_CONTRACT.map((e) => [e.source, e.source_class]),
    ),
  );

// SECURITY (DDR-1 §3.2, hard): source_class is SERVER-DERIVED from the arrival
// channel, NEVER caller-supplied — a caller asserting its own attestation level
// is self-attestation laundering, and the request DTO does not carry the field.
//
// Fail-closed default (DDR-1 §4, hard): any unmapped / unknown / reserved channel
// resolves to THIRD_PARTY_UNVERIFIED. A new channel earns a confirming class only
// by an explicit contract entry, never by omission.
export function deriveSourceClass(source: string): IngestionSourceClass {
  return SOURCE_CLASS_BY_SOURCE[source] ?? 'THIRD_PARTY_UNVERIFIED';
}
