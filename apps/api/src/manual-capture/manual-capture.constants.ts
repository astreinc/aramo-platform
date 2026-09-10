// TM-L1-C1 — Manual recruiter capture constants.
//
// Manual recruiter capture is a SOURCE event on the direct-capture channel — it
// enters through the same governed ingestion/provenance model as every other
// source (Arrival != Talent). These pin the channel classification; the
// authenticated recruiter is the ACTOR (recorded in SourcedTalent.provenance),
// never encoded into the source vocabulary.

// The ingestion source value (lowercase wire vocabulary). MUST be one of the
// TM-L1-A accepted four; talent_direct is the manual/direct-capture channel and
// server-derives to source_class SELF via the canonical source contract.
export const MANUAL_CAPTURE_SOURCE = 'talent_direct';

// The sourced_talent dedup-memory channel (uppercase — already in the documented
// SourceChannel starter set: INDEED | DICE | GITHUB | TALENT_DIRECT | ...).
export const MANUAL_CAPTURE_SOURCE_CHANNEL = 'TALENT_DIRECT';

// The object-storage channel segment (lowercase) for the raw JSON artifact.
export const MANUAL_CAPTURE_STORAGE_CHANNEL = 'talent_direct';
