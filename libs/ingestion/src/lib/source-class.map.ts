// TR-2a-B1 (DDR-1 §3.1 + §4) — the channel-source_class map.
//
// TM-L1-A: the source -> source_class mapping and the fail-closed default now
// live in the single canonical source contract (./source-contract.js), co-derived
// with the wire allowlist so the two cannot drift. This module preserves the
// historical import surface (deriveSourceClass, IngestionSourceClass) that
// ingestion.service / ingestion.repository / the barrel export and specs consume.
//
// DDR-1 §3.1 rules that source_class is DETERMINED IN THE INGESTION ADAPTER: the
// adapter is where channel knowledge already forks, so the mapping is a code-level
// closed map — auditable and git-versioned, NOT a DB table (a table would add an
// unauditable runtime mutation surface to an identity-critical decision).
//
// SECURITY (DDR-1 §3.2, hard): source_class is SERVER-DERIVED from the arrival
// channel, NEVER caller-supplied. A caller asserting its own attestation level is
// self-attestation laundering. The request DTO does not carry the field.
export type { IngestionSourceClass } from './source-contract.js';
export { deriveSourceClass } from './source-contract.js';
