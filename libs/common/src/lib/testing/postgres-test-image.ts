// Enterprise Search GS-2 P1 — the ONE canonical Postgres test-container image for the whole
// workspace (directive Aramo-Enterprise-Search-GS2-Hybrid-Semantic §P1). It is a pgvector-capable
// PostgreSQL 17 image: a drop-in for every existing non-vector integration spec (same PG17
// runtime), AND the only image under which a `CREATE EXTENSION vector` migration (GS-2A onward)
// can apply. Every Testcontainers caller MUST construct from this constant — a governance
// tripwire fails any new literal `postgres:` image used outside this module, so the workspace
// cannot silently split its DB test runtime again.
export const ARAMO_POSTGRES_TEST_IMAGE = 'pgvector/pgvector:pg17';
