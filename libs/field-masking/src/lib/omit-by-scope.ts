// Generic omit-by-scope helper (the rule-of-three promotion).
//
// AUTHZ-D5 introduced the omit-by-DELETE loop for compensation; Company-
// Fields v1.1 copied it for commercial; the Job-Module financials map is
// the THIRD consumer. Per the directive "promote the gating utility, don't
// copy a third time", the shared mechanism lives here and the three maps
// delegate to it.
//
// THE CONTRACT (identical across all three consumers):
//   - A field is VISIBLE iff at least one HELD scope's field list contains
//     it (EITHER-grants — a field is shown if ANY held scope lists it).
//   - Masking is FIELD-OMISSION by DELETE (key absent from the JSON, NOT
//     key-present-with-null) — `delete out[k]` on a shallow `{...view}`
//     clone so JSON.stringify drops the key.
//   - The gated set is the UNION of every field across the map; any field
//     NOT in the map passes through untouched. compensation_model and
//     other discriminator labels are simply absent from the map.
//
// Generic over T so callers don't lose the concrete view type at the call
// site (the delegating maps re-export their own typed signatures).
export function omitFieldsByScopeMap<T extends Record<string, unknown>>(
  view: T,
  scopes: Iterable<string>,
  scopeToFields: Readonly<Record<string, readonly string[]>>,
): T {
  // Fields the actor's held scopes make visible (union over held scopes).
  const held = new Set(scopes);
  const visible = new Set<string>();
  for (const scope of held) {
    const fields = scopeToFields[scope];
    if (fields === undefined) continue;
    for (const field of fields) visible.add(field);
  }

  // The union of ALL gated fields across the map — delete any gated field
  // not made visible by a held scope.
  const out: Record<string, unknown> = { ...view };
  for (const fields of Object.values(scopeToFields)) {
    for (const field of fields) {
      if (!visible.has(field) && field in out) {
        delete out[field];
      }
    }
  }
  return out as T;
}
