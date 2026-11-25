// TEMPLATE-FIELDS-1 (Aramo-Template-Fields-1-Directive-v1_0-LOCKED) — the Studio's model of the
// fields placed INSIDE the text (rtr-html-v3 markers). The content holds only the marker; each
// field's type, role and settings ride beside the blocks in the Studio document (so undo / redo
// covers them) and are saved WITH the content as the version's rows (platform, F-14). A tenant
// copy keeps them locked (F-15). The server is authoritative for every rule (F-3, F-6, F-9).

import { FIELD_CATALOG, isFieldTypeKey } from '@aramo/sign-fields';
import { settingsFromWire, settingsToWire, type PlacementSettings, type WireSettings } from '@aramo/field-placement-web';

import { studioFieldKeys, type StudioBlock, type StudioFieldChipInfo, type StudioFieldChipResolver } from '../studio-codec';

import type { CheckItem } from './readiness';
import type { StudioSigning } from './data-source';

/** One inline field of the Studio document. */
export interface StudioInlineField {
  readonly field_key: string;
  readonly field_type: string;
  /** A SIGNER role key, or null when the sender fills it (F-7). */
  readonly signer_role: string | null;
  readonly required: boolean;
  readonly settings: PlacementSettings;
}

/** A stored row as the server returns it (GET …/versions/:id/fields). */
export interface StudioInlineFieldRow extends WireSettings {
  readonly field_key: string;
  readonly field_type: string;
  readonly signer_role: string | null;
  readonly required: boolean;
  readonly ordinal?: number;
}

/** The wire form a draft save sends (`fields`, no geometry). */
export interface StudioInlineFieldWire extends Record<string, unknown> {
  readonly field_key: string;
  readonly field_type: string;
  readonly signer_role: string | null;
  readonly required: boolean;
  readonly ordinal: number;
}

export function inlineFieldFromRow(r: StudioInlineFieldRow): StudioInlineField {
  return { field_key: r.field_key, field_type: r.field_type, signer_role: r.signer_role, required: r.required, settings: settingsFromWire(r) };
}

export function inlineFieldToWire(f: StudioInlineField, ordinal: number): StudioInlineFieldWire {
  return {
    field_key: f.field_key,
    field_type: f.field_type,
    signer_role: f.signer_role,
    required: f.required,
    ordinal,
    ...settingsToWire(f.field_type, f.settings, { members: 'set' }),
  };
}

/** Every field key placed in the blocks, in document order. */
export function inlineFieldKeysOf(blocks: readonly Pick<StudioBlock, 'value'>[]): string[] {
  return blocks.flatMap((b) => studioFieldKeys(b.value));
}

/**
 * The rows a save sends: the document's fields that are placed in the text, in text order (a
 * field whose chip was deleted is dropped; undo brings the chip and its row back together).
 */
export function inlineFieldsToSave(blocks: readonly Pick<StudioBlock, 'value'>[], fields: readonly StudioInlineField[]): StudioInlineFieldWire[] {
  const byKey = new Map(fields.map((f) => [f.field_key, f]));
  const out: StudioInlineFieldWire[] = [];
  for (const key of inlineFieldKeysOf(blocks)) {
    const f = byKey.get(key);
    if (f !== undefined && !out.some((o) => o.field_key === key)) out.push(inlineFieldToWire(f, out.length));
  }
  return out;
}

/** A new field key for `type` ("signature_1", "initials_2", …), never one already used. */
export function nextInlineFieldKey(type: string, used: readonly string[]): string {
  const base = type.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]+/, '') || 'field';
  for (let n = 1; ; n += 1) {
    const key = `${base}_${n}`.slice(0, 64);
    if (!used.includes(key)) return key;
  }
}

/** The SIGNER roles of the document's signing, in order. */
export function signerRolesFor(signing: StudioSigning | null | undefined): { role_key: string; label: string }[] {
  return (signing?.roles ?? []).filter((r) => r.kind === 'SIGNER').map((r) => ({ role_key: r.role_key, label: r.label }));
}

/** F-7 — whether the type may be sender-filled (its catalog settings include sender_filled). */
export function canBeSenderFilled(type: string): boolean {
  return isFieldTypeKey(type) && (FIELD_CATALOG[type].settings as readonly string[]).includes('sender_filled');
}

/** How each field chip looks (F-7: a field shows its type and who fills it, unlike a variable). */
export function inlineFieldChipResolver(fields: readonly StudioInlineField[], signing: StudioSigning | null | undefined, locked: boolean): StudioFieldChipResolver {
  const roles = signerRolesFor(signing);
  const byKey = new Map(fields.map((f) => [f.field_key, f]));
  return (key): StudioFieldChipInfo | null => {
    const f = byKey.get(key);
    if (f === undefined) return null;
    const entry = isFieldTypeKey(f.field_type) ? FIELD_CATALOG[f.field_type] : null;
    const tone = f.signer_role === null ? -1 : Math.max(0, roles.findIndex((r) => r.role_key === f.signer_role));
    const role = f.signer_role === null ? 'Sender fills it' : (roles.find((r) => r.role_key === f.signer_role)?.label ?? f.signer_role);
    const label = f.settings.label.trim() !== '' ? f.settings.label.trim() : (entry?.label ?? f.field_type);
    return { glyph: entry?.glyph ?? '▢', label, role, tone, locked };
  };
}

/**
 * The publishing checks of the fields in the text (shown in Checks; the server re-checks):
 * F-17 an `ats` template cannot have them (blocking); F-6 they need signing roles; each field
 * has its settings and a role (or is sender-filled); F-15 a tenant copy keeps exactly the
 * fields Aramo placed.
 */
export function inlineFieldChecks(input: {
  readonly blocks: readonly Pick<StudioBlock, 'value'>[];
  readonly fields: readonly StudioInlineField[];
  readonly signing: StudioSigning | null | undefined;
  readonly products: readonly string[] | null | undefined;
  /** F-15 — the field keys a tenant copy must keep (null on the platform). */
  readonly lockedKeys: readonly string[] | null;
}): CheckItem[] {
  const keys = inlineFieldKeysOf(input.blocks);
  const items: CheckItem[] = [];
  if (input.lockedKeys !== null) {
    const now = [...new Set(keys)].sort().join(',');
    const was = [...input.lockedKeys].sort().join(',');
    if (input.lockedKeys.length > 0 || keys.length > 0) {
      items.push({
        id: 'fields-locked',
        label: 'Fields placed by Aramo are kept',
        ok: now === was,
        severity: 'fail',
        detail: 'You can edit the wording around the fields, but not add, remove or change them. Undo to bring a field back.',
      });
    }
    return items;
  }
  if (keys.length === 0) return items;
  const ats = (input.products ?? []).some((p) => p.toLowerCase() === 'ats');
  items.push({
    id: 'fields-ats',
    label: 'No fields in the text of an ATS template',
    ok: !ats,
    severity: 'fail',
    detail: 'ATS cannot send fields placed in the text yet. Remove the ATS tag in Properties, or remove the fields.',
  });
  const signers = signerRolesFor(input.signing);
  items.push({
    id: 'fields-roles',
    label: 'Fields have signing roles',
    ok: signers.length > 0,
    severity: 'fail',
    detail: 'A template with fields in its text needs signing roles (Roles tab).',
  });
  const byKey = new Map(input.fields.map((f) => [f.field_key, f]));
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  for (const k of [...new Set(dup)]) {
    items.push({ id: `field-dup:${k}`, label: `Field ${k} is placed twice`, ok: false, severity: 'fail', detail: 'Each field is placed once. Delete one of them.' });
  }
  for (const k of [...new Set(keys)]) {
    const f = byKey.get(k);
    if (f === undefined) {
      items.push({ id: `field-missing:${k}`, label: `Field ${k} has no settings`, ok: false, severity: 'fail', detail: 'Delete the field and insert it again.' });
      continue;
    }
    const roleOk = f.signer_role === null ? f.settings.senderFilled && canBeSenderFilled(f.field_type) : signers.some((r) => r.role_key === f.signer_role);
    if (!roleOk) {
      items.push({ id: `field-role:${k}`, label: `Field ${k} needs a signing role`, ok: false, severity: 'fail', detail: 'Click the field and choose who fills it.' });
    }
  }
  return items;
}
