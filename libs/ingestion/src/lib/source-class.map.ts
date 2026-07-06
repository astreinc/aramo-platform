// TR-2a-B1 (DDR-1 §3.1 + §4) — the channel-source_class map.
//
// DDR-1 §3.1 rules that source_class is DETERMINED IN THE INGESTION ADAPTER:
// the adapter is where channel knowledge already forks, so the mapping is a
// code-level closed map here — auditable and git-versioned, NOT a DB table (a
// table would add an unauditable runtime mutation surface to an identity-
// critical decision).
//
// SECURITY (DDR-1 §3.2, hard): source_class is SERVER-DERIVED from the arrival
// channel, NEVER caller-supplied. A caller asserting its own attestation level
// is self-attestation laundering. The request DTO does not carry the field.
//
// The values mirror talent_trust SourceClass but are declared LOCALLY so
// ingestion takes no cross-lib import edge (directive §5 — no new @aramo/* edge
// in B1). B1 emits only SELF and THIRD_PARTY_UNVERIFIED; a future channel whose
// documented semantics attest verification (e.g. Indeed Apply verified=true)
// maps to THIRD_PARTY_VERIFIED by a later map amendment that lands with its
// producer — no dead vocabulary here.
export type IngestionSourceClass = 'SELF' | 'THIRD_PARTY_UNVERIFIED';

// DDR-1 §4 verbatim: talent_direct is a first-party declaration (SELF);
// github / astre_import / indeed carry unverified third-party claims.
const CHANNEL_SOURCE_CLASS: Record<string, IngestionSourceClass> = {
  talent_direct: 'SELF',
  github: 'THIRD_PARTY_UNVERIFIED',
  astre_import: 'THIRD_PARTY_UNVERIFIED',
  indeed: 'THIRD_PARTY_UNVERIFIED',
};

// Fail-closed default (DDR-1 §4, hard): any unmapped or unknown channel is
// THIRD_PARTY_UNVERIFIED. A new channel earns confirming status only by an
// explicit map amendment, never by omission.
export function deriveSourceClass(source: string): IngestionSourceClass {
  return CHANNEL_SOURCE_CLASS[source] ?? 'THIRD_PARTY_UNVERIFIED';
}
