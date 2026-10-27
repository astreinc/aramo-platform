import { describe, expect, it } from 'vitest';

import { signatureFields } from '../documents/sign-template-library.service.js';
import { RIGHT_TO_REPRESENT_TYPE_ID } from '../rtr/rtr-constants.js';
import { RTR_HTML_SCHEMA_V1, parseHtmlContent, parseSigningConfig, type RtrTemplateContentHtmlV1 } from '../rtr/rtr-html-content.js';
import { RtrTemplateBindingService } from '../rtr/rtr-template-binding.service.js';
import { RtrTemplateCapabilities } from '../rtr/rtr-template-capabilities.service.js';

import { fakeCatalog } from './fixtures/rtr-seed-catalog.js';

// Amendment M-A6 (LOCKED) §3.2–§3.3 — the rtr-html-v1 `signing` member (roles, routing,
// defaults): kept and validated by the parser and normalizeDraftContent, absent ⇒ the
// content is byte-identical to before; the Sign render binds one block per SIGNER role
// (printed name is a SIGNER_NAME placement Sign fills); ATS binding is unchanged.

const SIGNING = {
  roles: [
    { role_key: 'agency', label: ' Agency ', kind: 'SIGNER', order: 2 },
    { role_key: 'client', label: 'Client', kind: 'SIGNER', order: 1 },
    { role_key: 'hr_copy', label: 'HR copy', kind: 'CC', order: 3 },
  ],
  routing_mode: 'SEQUENTIAL',
  default_subject: '  Please sign  ',
};

const HTML = '<p>Represented for <span data-field="requisition.title"></span>.</p>';

function issue(raw: unknown): string | null {
  const r = parseSigningConfig(raw);
  return 'issue' in r ? r.issue : null;
}

describe('parseSigningConfig (M-A6 §3.2)', () => {
  it('canonicalises: roles sorted by order, labels and defaults trimmed, empty defaults omitted', () => {
    const r = parseSigningConfig({ ...SIGNING, default_message: '   ' });
    expect('signing' in r && r.signing).toEqual({
      roles: [
        { role_key: 'client', label: 'Client', kind: 'SIGNER', order: 1 },
        { role_key: 'agency', label: 'Agency', kind: 'SIGNER', order: 2 },
        { role_key: 'hr_copy', label: 'HR copy', kind: 'CC', order: 3 },
      ],
      routing_mode: 'SEQUENTIAL',
      default_subject: 'Please sign',
    });
  });

  it('refuses every invalid shape with a stable reason', () => {
    const role = (o: Record<string, unknown>) => ({ ...SIGNING, roles: [{ role_key: 'a', label: 'A', kind: 'SIGNER', order: 1, ...o }] });
    expect(issue(null)).toBe('signing_not_object');
    expect(issue({ ...SIGNING, extra: 1 })).toBe('signing_unknown_member');
    expect(issue({ ...SIGNING, roles: [] })).toBe('signing_roles_required');
    expect(issue({ ...SIGNING, roles: [{ role_key: 'cc', label: 'CC', kind: 'CC', order: 1 }] })).toBe('signing_signer_role_required');
    expect(issue(role({ role_key: 'Bad Key' }))).toBe('signing_role_key_invalid');
    expect(issue(role({ label: '' }))).toBe('signing_role_label_invalid');
    expect(issue(role({ label: 'Signer ☃' }))).toBe('signing_role_label_invalid');
    expect(issue(role({ kind: 'VIEWER' }))).toBe('signing_role_kind_invalid');
    expect(issue(role({ order: 0 }))).toBe('signing_role_order_invalid');
    expect(issue(role({ order: 1.5 }))).toBe('signing_role_order_invalid');
    expect(issue(role({ color: 'red' }))).toBe('signing_role_unknown_member');
    expect(
      issue({ ...SIGNING, roles: [{ role_key: 'a', label: 'A', kind: 'SIGNER', order: 1 }, { role_key: 'a', label: 'B', kind: 'SIGNER', order: 2 }] }),
    ).toBe('signing_role_key_duplicate');
    expect(
      issue({ ...SIGNING, roles: [{ role_key: 'a', label: 'A', kind: 'SIGNER', order: 1 }, { role_key: 'b', label: 'B', kind: 'SIGNER', order: 1 }] }),
    ).toBe('signing_role_order_duplicate');
    expect(issue({ ...SIGNING, routing_mode: 'RANDOM' })).toBe('signing_routing_mode_invalid');
    expect(issue({ ...SIGNING, default_subject: 'x'.repeat(201) })).toBe('signing_default_subject_too_long');
    const eleven = Array.from({ length: 11 }, (_v, i) => ({ role_key: `s${i}`, label: `S${i}`, kind: 'SIGNER', order: i + 1 }));
    expect(issue({ ...SIGNING, roles: eleven })).toBe('signing_too_many_signer_roles');
  });
});

describe('rtr-html-v1 parse keeps `signing` (M-A6 §3.2)', () => {
  it('a content without signing parses exactly as before (no signing key)', () => {
    const c = parseHtmlContent({ render_schema_version: RTR_HTML_SCHEMA_V1, title: 'T', html: HTML, logo: null });
    expect(c).toEqual({ render_schema_version: RTR_HTML_SCHEMA_V1, title: 'T', html: HTML, logo: null });
    expect(c !== null && 'signing' in c).toBe(false);
  });

  it('keeps a valid signing and fails closed on an invalid one', () => {
    const c = parseHtmlContent({ render_schema_version: RTR_HTML_SCHEMA_V1, title: 'T', html: HTML, signing: SIGNING });
    expect(c?.signing?.roles.map((r) => r.role_key)).toEqual(['client', 'agency', 'hr_copy']);
    expect(parseHtmlContent({ render_schema_version: RTR_HTML_SCHEMA_V1, title: 'T', html: HTML, signing: { roles: [] } })).toBeNull();
  });
});

describe('normalizeDraftContent keeps and validates `signing` (M-A6 §3.2)', () => {
  const caps = new RtrTemplateCapabilities(fakeCatalog());
  const norm = (field_schema: unknown, existing: unknown = null) =>
    caps.normalizeDraftContent({
      document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
      render_schema_version: RTR_HTML_SCHEMA_V1,
      field_schema,
      existing_field_schema: existing,
      requestId: 'r',
    }) as Promise<RtrTemplateContentHtmlV1>;

  it('without signing the stored content is byte-identical to before', async () => {
    const out = await norm({ render_schema_version: RTR_HTML_SCHEMA_V1, title: ' T ', html: HTML });
    expect(JSON.stringify(out)).toBe(JSON.stringify({ render_schema_version: RTR_HTML_SCHEMA_V1, title: 'T', html: HTML, logo: null }));
  });

  it('keeps a valid signing (canonical form)', async () => {
    const out = await norm({ render_schema_version: RTR_HTML_SCHEMA_V1, title: 'T', html: HTML, signing: SIGNING });
    expect(out.signing?.roles.map((r) => `${r.order}:${r.role_key}`)).toEqual(['1:client', '2:agency', '3:hr_copy']);
    expect(out.signing?.routing_mode).toBe('SEQUENTIAL');
  });

  it('absent ⇒ the existing draft signing carries over; null ⇒ removed', async () => {
    const existing = { render_schema_version: RTR_HTML_SCHEMA_V1, title: 'T', html: HTML, signing: SIGNING };
    const kept = await norm({ render_schema_version: RTR_HTML_SCHEMA_V1, title: 'T2', html: HTML }, existing);
    expect(kept.signing?.roles).toHaveLength(3);
    const removed = await norm({ render_schema_version: RTR_HTML_SCHEMA_V1, title: 'T2', html: HTML, signing: null }, existing);
    expect('signing' in removed).toBe(false);
  });

  it('refuses an invalid signing (422, stable reason)', async () => {
    await expect(norm({ render_schema_version: RTR_HTML_SCHEMA_V1, title: 'T', html: HTML, signing: { ...SIGNING, routing_mode: 'X' } })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 422,
    });
    await expect(norm({ render_schema_version: RTR_HTML_SCHEMA_V1, title: 'T', html: HTML, signing: { ...SIGNING, routing_mode: 'X' } })).rejects.toMatchObject({
      context: { details: { reason: 'signing_routing_mode_invalid' } },
    });
  });
});

describe('binding (M-A6 §3.3) — Sign renders one block per SIGNER role; ATS unchanged', () => {
  const tenants = { findBrandingById: async () => null, findLegalNameById: async () => null };
  const binding = new RtrTemplateBindingService({} as never, {} as never, {} as never, tenants as never, {} as never);
  const withRoles = parseHtmlContent({ render_schema_version: RTR_HTML_SCHEMA_V1, title: 'Agreement', html: HTML, signing: SIGNING }) as RtrTemplateContentHtmlV1;
  const plain = parseHtmlContent({ render_schema_version: RTR_HTML_SCHEMA_V1, title: 'Agreement', html: HTML }) as RtrTemplateContentHtmlV1;

  it('usedKeys: the printed name is Sign-filled for a template with roles (no talent.full_name)', () => {
    expect(binding.usedKeys(withRoles, 'r')).toEqual(['requisition.title']);
    expect(binding.usedKeys(plain, 'r').sort()).toEqual(['requisition.title', 'talent.full_name']);
  });

  it('bindProvided with roles ⇒ signature_blocks per SIGNER role in order (CC roles draw nothing), no single block', async () => {
    const model = await binding.bindProvided({
      content: withRoles,
      template_version_id: 'v',
      tenant_id: 't',
      values: new Map([['requisition.title', 'Analyst']]),
      requestId: 'r',
    });
    expect(model.signature_blocks).toEqual([
      { role_key: 'client', label: 'Client' },
      { role_key: 'agency', label: 'Agency' },
    ]);
    expect(model.signature_block).toBeUndefined();
  });

  it('bindProvided without roles ⇒ the single talent block, exactly as before', async () => {
    const model = await binding.bindProvided({
      content: plain,
      template_version_id: 'v',
      tenant_id: 't',
      values: new Map([
        ['requisition.title', 'Analyst'],
        ['talent.full_name', 'Ravi Shankar'],
      ]),
      requestId: 'r',
    });
    expect(model.signature_block).toEqual({ printed_name: 'Ravi Shankar' });
    expect(model.signature_blocks).toBeUndefined();
  });
});

describe('signatureFields (M-A6 §3.3) — render response placements', () => {
  const manifest = {
    signature_fields: [
      { field_type: 'SIGNATURE', page_number: 0, x: 1, y: 2, width: 3, height: 4, role_key: 'client' },
      { field_type: 'SIGNER_NAME', page_number: 0, x: 1, y: 2, width: 3, height: 4, role_key: 'client' },
      { field_type: 'SIGN_DATE', page_number: 0, x: 1, y: 2, width: 3, height: 4, role_key: 'client' },
    ],
  };
  it('without roles: SIGNATURE + SIGN_DATE only, no role_key (unchanged)', () => {
    const single = {
      signature_fields: manifest.signature_fields.map((f) => {
        const copy: Record<string, unknown> = { ...f };
        delete copy['role_key'];
        return copy;
      }),
    };
    expect(signatureFields(single)).toEqual([
      { field_type: 'SIGNATURE', page_number: 0, x: 1, y: 2, width: 3, height: 4 },
      { field_type: 'SIGN_DATE', page_number: 0, x: 1, y: 2, width: 3, height: 4 },
    ]);
  });
  it('with roles: every placement incl. SIGNER_NAME, each with its role_key', () => {
    expect(signatureFields(manifest, true).map((f) => `${f.role_key}:${f.field_type}`)).toEqual(['client:SIGNATURE', 'client:SIGNER_NAME', 'client:SIGN_DATE']);
  });
});
