// TR-2a-B2 (DDR-2 Amendment v1.1 §2.2) — the CONFIRMED-arm corroborator-conflict
// NAME predicate. Pure, deterministic, total (no I/O, no LLM), beside
// isConfirmingAnchor. Consumed ONLY by the resolver's CONFIRMED arm.
//
// The guard is conservative in the SPLIT direction (§2.2): a wrong demotion
// costs one advisory a human dismisses; a wrong auto-resolve is the catastrophic
// case. So a conflict DEMOTES the confirming hit to the split arm.
//
//   - Normalize each name: fold diacritics, lowercase, strip punctuation,
//     tokenize on whitespace.
//   - Flat conflict = BOTH token sets non-empty AND zero token overlap.
//   - Absence NEVER conflicts (a missing name is missing evidence, not
//     contradicting evidence) — an empty-after-normalize name counts as absent.
//
// Worked (§2.2): "Bob Smith" vs "Robert Smith" share `smith` -> no conflict
// (nickname variance tolerated); "Jane Doe" vs "Priya Sharma" -> zero overlap ->
// conflict; "Bob Jones" vs "Robert Smith" -> zero overlap -> conflict.

function tokenizeName(name: string): Set<string> {
  return new Set(
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // fold combining diacritics
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ') // strip punctuation to whitespace
      .split(/\s+/)
      .filter((t) => t.length > 0),
  );
}

// Flat NAME conflict between an arrival's declared name and a target's known
// name. Either side null/absent, or empty after normalization -> NO conflict.
export function namesFlatlyConflict(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const ta = tokenizeName(a);
  const tb = tokenizeName(b);
  if (ta.size === 0 || tb.size === 0) return false; // absence never conflicts
  for (const t of ta) {
    if (tb.has(t)) return false; // any shared token -> not a flat conflict
  }
  return true; // both non-empty, zero overlap -> flat conflict
}
