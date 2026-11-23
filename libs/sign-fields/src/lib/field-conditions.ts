// FIELD-PARITY-2 (Aramo-Sign-Field-Placement-Conditional-Fields-Directive-v1_0-LOCKED) §4 Phase B —
// field keys and conditional fields, ONE rule for every API that writes a field: the Sign sender
// API (PUT …/fields), the documents template field route, the console fixed form, the template →
// envelope carry and the web editor.
//
// B-1 — a field's stable key. A template field has always had one (field_key, unique per
// version); an envelope field gets one too (sign SignatureField.field_key, unique per envelope),
// set from the template's key at carry time and from the editor's id when a sender saves. A
// condition names its trigger by this key, never by row id (the replace-all PUT re-creates rows).
//
// Pure TypeScript ESM, no dependency (scope:shared).

/** The longest field key an envelope field stores (the sign SignatureField_field_key_check CHECK). */
export const FIELD_KEY_MAX = 200;

/** Whether `v` is a field key an envelope field can store: text of 1 to FIELD_KEY_MAX characters, not blank. */
export function isFieldKey(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= FIELD_KEY_MAX && v.trim().length > 0;
}

/** The keys that appear more than once (NULL / absent keys are never duplicates), in first-seen order. */
export function duplicateFieldKeys(fields: readonly { readonly field_key?: string | null }[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const f of fields) {
    const k = f.field_key;
    if (k === undefined || k === null) continue;
    if (seen.has(k)) dup.add(k);
    seen.add(k);
  }
  return [...dup];
}
