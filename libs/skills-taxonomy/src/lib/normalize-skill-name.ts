// Canonical Skill lookup-key normalization (SKILL-TAX-1A).
//
// trim -> lowercase -> collapse internal whitespace. This is the load-bearing
// collision key for the canonical Skill registry: "Kubernetes", "kubernetes"
// and "  Kubernetes " all normalize to "kubernetes" and therefore resolve to
// ONE canonical Skill.
//
// This MIRRORS the algorithm of @aramo/talent-extraction normalizeSkillSurfaceForm
// (libs/talent-extraction/src/lib/skill-id.ts) so that 1C canonicalization can
// resolve stored surface forms onto the same key. It is defined INDEPENDENTLY
// here and MUST NOT import or alter that function — the two legacy deriveSkillId
// / normalizeSkillSurfaceForm implementations are a DO-NOT-TOUCH invariant for
// SKILL-TAX-1. A unit test asserts byte-for-byte algorithm parity so any future
// drift is caught (libs/skills-taxonomy/src/tests/normalize-skill-name.spec.ts).
export function normalizeSkillName(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Version lookup key (SKILL-TAX-1B): trim + lowercase. Versions carry no
// internal whitespace, so this is a lighter normalization than skill names
// (e.g. " 17 " -> "17", "V17" -> "v17"). Kept deterministic and repeatable.
export function normalizeVersion(input: string): string {
  return input.trim().toLowerCase();
}
