import { createHash } from 'node:crypto';

import { PDFDocument } from 'pdf-lib';
import { PdfLibDocumentRenderingAdapter, type PreparedField, type RenderBlock } from '@aramo/documents-rendering';
import { describe, expect, it, vi } from 'vitest';

import {
  ExecutionService,
  NOT_SHOWN,
  fieldValueLines,
  hiddenFieldIds,
  hiddenFieldLines,
  radioGroupLines,
  shownOnly,
} from '../lib/execution.service.js';

// FIELD-PARITY-2 (Aramo-Sign-Field-Placement-Conditional-Fields-Directive-v1_0-LOCKED) §4 B-8,
// ruling C-4 — a field hidden at completion is not drawn on the executed PDF (no empty box, no
// value) and the certificate lists it once as "not shown (its condition was not met)". A shown
// field, and every envelope without conditions, is exactly as before.

const at = new Date('2026-11-20T10:00:00Z');

type Row = {
  id: string;
  envelope_document_id: string;
  tenant_id: string;
  signer_id: string | null;
  field_type: string;
  field_key: string | null;
  condition: unknown;
  label: string | null;
  page_number: number;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  value: string | null;
  filled_at: Date | null;
  signature_method: string | null;
  group_key: string | null;
  sender_filled: boolean;
  options: unknown;
  font_size: number | null;
};

let seq = 0;
function row(over: Partial<Row>): Row {
  seq += 1;
  return {
    id: `f${seq}`,
    envelope_document_id: 'd1',
    tenant_id: 't1',
    signer_id: 's1',
    field_type: 'TEXT',
    field_key: null,
    condition: null,
    label: null,
    page_number: 0,
    x: 72,
    y: 100 + (seq % 20) * 30,
    width: 180,
    height: 22,
    value: null,
    filled_at: null,
    signature_method: null,
    group_key: null,
    sender_filled: false,
    options: null,
    font_size: null,
    ...over,
  };
}
const filled = (value: string) => ({ value, filled_at: at });

async function blankSource(): Promise<Uint8Array> {
  const src = await PDFDocument.create();
  src.addPage([600, 800]);
  return src.save({ useObjectStreams: false });
}

// ExecutionService over stub ports: the PDF stamper is the real pdf-lib adapter; the rows are
// what the per-document query would return (filled fields plus every check-box kind).
function harness(docRows: Row[]) {
  const adapter = new PdfLibDocumentRenderingAdapter();
  const seen: PreparedField[][] = [];
  const rendering = {
    prepareFromSource: vi.fn(async (src: Uint8Array, placements: PreparedField[]) => {
      seen.push(placements);
      return adapter.prepareFromSource(src, placements);
    }),
  };
  const prisma = {
    signatureField: {
      findMany: vi.fn(async () => docRows.filter((r) => r.filled_at !== null || ['CHECKBOX', 'ACKNOWLEDGEMENT', 'RADIO'].includes(r.field_type))),
    },
  };
  let source: Uint8Array | null = null;
  const sourcePort = { getSourcePdf: vi.fn(async () => (source ??= await blankSource())) };
  const svc = new ExecutionService(prisma as never, {} as never, rendering as never, sourcePort as never);
  const render = (hidden?: ReadonlySet<string>) =>
    (svc as unknown as {
      renderExecutedDocument: (
        t: string,
        doc: unknown,
        stampFor: () => { label: string; id: string },
        ctx: object,
        hidden?: ReadonlySet<string>,
      ) => Promise<{ rendered: { bytes: Uint8Array; sha256: string } }>;
    }).renderExecutedDocument('t1', { id: 'd1', source_mode: 'OWNED', document_ref: 'r', document_revision_ref: 'v', source_object_key: 'k' }, () => ({ label: 'Signed by:', id: 'ABC' }), {}, hidden);
  return { render, seen };
}

const keys = (placements: PreparedField[] | undefined): string[] => (placements ?? []).map((p) => p.field_key);

describe('B-8 — which fields are hidden at completion (hiddenFieldIds)', () => {
  it('an envelope without conditions hides nothing', () => {
    expect(hiddenFieldIds([row({ field_type: 'CHECKBOX' }), row({ ...filled('x') })]).size).toBe(0);
  });

  it('per signer, across documents: a trigger on another document of the same envelope counts', () => {
    const trigger = row({ envelope_document_id: 'd2', field_type: 'CHECKBOX', field_key: 'agree', ...filled('false') });
    const dep = row({ field_key: 'why', condition: { trigger_key: 'agree', when: 'checked' } });
    expect([...hiddenFieldIds([trigger, dep])]).toEqual([dep.id]);
    expect(hiddenFieldIds([{ ...trigger, value: 'true' }, dep]).size).toBe(0);
  });

  it('the same key on another signer is not the trigger (same-signer rule); unassigned is its own group', () => {
    const otherSigners = row({ signer_id: 's2', field_type: 'CHECKBOX', field_key: 'agree', ...filled('true') });
    const mine = row({ field_type: 'CHECKBOX', field_key: 'agree', ...filled('false') });
    const dep = row({ condition: { trigger_key: 'agree', when: 'checked' } });
    const unassigned = row({ signer_id: null, condition: { trigger_key: 'agree', when: 'checked' } });
    // The unassigned field's trigger is not in its group: fail-open (shown).
    expect([...hiddenFieldIds([otherSigners, mine, dep, unassigned])]).toEqual([dep.id]);
  });

  it('a chain: a hidden trigger hides the whole chain below it', () => {
    const a = row({ field_type: 'CHECKBOX', field_key: 'a', ...filled('false') });
    const b = row({ field_type: 'CHECKBOX', field_key: 'b', condition: { trigger_key: 'a', when: 'checked' } });
    const c = row({ field_key: 'c', condition: { trigger_key: 'b', when: 'unchecked' } });
    expect(new Set(hiddenFieldIds([a, b, c]))).toEqual(new Set([b.id, c.id]));
  });

  it('an unfilled value (filled_at NULL) reads as empty', () => {
    const a = row({ field_type: 'CHECKBOX', field_key: 'a', value: 'true', filled_at: null });
    const b = row({ condition: { trigger_key: 'a', when: 'checked' } });
    expect([...hiddenFieldIds([a, b])]).toEqual([b.id]);
  });
});

describe('B-8 — the executed PDF', () => {
  it('a hidden check box is not drawn (no empty box); a shown one is', async () => {
    const trigger = row({ field_type: 'CHECKBOX', field_key: 'agree', ...filled('false') });
    const hiddenBox = row({ field_type: 'CHECKBOX', condition: { trigger_key: 'agree', when: 'checked' } });
    const hiddenAck = row({ field_type: 'ACKNOWLEDGEMENT', condition: { trigger_key: 'agree', when: 'checked' } });
    const shownBox = row({ field_type: 'CHECKBOX', condition: { trigger_key: 'agree', when: 'unchecked' } });
    const rows = [trigger, hiddenBox, hiddenAck, shownBox];
    const { render, seen } = harness(rows);
    await render(hiddenFieldIds(rows));
    expect(keys(seen[0])).toEqual([trigger.id, shownBox.id]);
    expect(seen[0]?.find((p) => p.field_key === shownBox.id)).toMatchObject({ kind: 'MARK', checked: false });
  });

  it('hidden radio options are not drawn', async () => {
    const pick = row({ field_type: 'DROPDOWN', field_key: 'plan', ...filled('basic') });
    const r1 = row({ field_type: 'RADIO', group_key: 'tier', condition: { trigger_key: 'plan', when: 'one_of', values: ['pro'] } });
    const r2 = row({ field_type: 'RADIO', group_key: 'tier', condition: { trigger_key: 'plan', when: 'one_of', values: ['pro'] } });
    const rows = [pick, r1, r2];
    const { render, seen } = harness(rows);
    await render(hiddenFieldIds(rows));
    expect(keys(seen[0])).toEqual([pick.id]);
  });

  it('a hidden text field is not drawn, even if a value were somehow still stored', async () => {
    const trigger = row({ field_type: 'CHECKBOX', field_key: 'agree', ...filled('false') });
    const text = row({ condition: { trigger_key: 'agree', when: 'checked' }, ...filled('should not print') });
    const shownText = row({ ...filled('prints') });
    const rows = [trigger, text, shownText];
    const { render, seen } = harness(rows);
    await render(hiddenFieldIds(rows));
    expect(keys(seen[0])).toEqual([trigger.id, shownText.id]);
  });

  it('a chain: the grandchild of a hidden trigger is not drawn', async () => {
    const a = row({ field_type: 'CHECKBOX', field_key: 'a', ...filled('false') });
    const b = row({ field_type: 'CHECKBOX', field_key: 'b', condition: { trigger_key: 'a', when: 'checked' } });
    const c = row({ field_type: 'CHECKBOX', field_key: 'c', condition: { trigger_key: 'b', when: 'unchecked' } });
    const rows = [a, b, c];
    const { render, seen } = harness(rows);
    await render(hiddenFieldIds(rows));
    expect(keys(seen[0])).toEqual([a.id]);
  });

  it('shown unchanged: an envelope without conditions stamps byte-identically to the pre-B-8 path', async () => {
    const rows = [
      row({ field_type: 'CHECKBOX', ...filled('true') }),
      row({ field_type: 'CHECKBOX' }),
      row({ field_type: 'ACKNOWLEDGEMENT', ...filled('true') }),
      row({ field_type: 'RADIO', group_key: 'g', ...filled('true') }),
      row({ field_type: 'RADIO', group_key: 'g' }),
      row({ ...filled('Jane Doe') }),
      row({ field_type: 'DATE', ...filled('2026-03-04') }),
      row({ field_type: 'SIGNATURE', signature_method: 'TYPED', ...filled('Jane Doe') }),
    ];
    const legacy = harness(rows);
    const before = await legacy.render(); // no hidden set: the pre-B-8 call
    const now = harness(rows);
    const after = await now.render(hiddenFieldIds(rows));
    expect(now.seen[0]).toEqual(legacy.seen[0]);
    expect(keys(now.seen[0])).toHaveLength(8);
    expect(createHash('sha256').update(after.rendered.bytes).digest('hex')).toBe(createHash('sha256').update(before.rendered.bytes).digest('hex'));
    expect(after.rendered.sha256).toBe(before.rendered.sha256);
  });

  it('shown fields of an envelope WITH conditions stamp exactly as they would without the hidden ones', async () => {
    const trigger = row({ field_type: 'CHECKBOX', field_key: 'agree', ...filled('true') });
    const shown = row({ condition: { trigger_key: 'agree', when: 'checked' }, ...filled('kept') });
    const hidden = row({ field_type: 'CHECKBOX', condition: { trigger_key: 'agree', when: 'unchecked' } });
    const withHidden = harness([trigger, shown, hidden]);
    await withHidden.render(hiddenFieldIds([trigger, shown, hidden]));
    const plain = harness([trigger, shown]);
    await plain.render();
    expect(withHidden.seen[0]).toEqual(plain.seen[0]);
  });
});

describe('B-8 — the certificate', () => {
  it('hidden fields leave the check-box, radio and value lines and are listed once as not shown', () => {
    const trigger = row({ field_type: 'CHECKBOX', field_key: 'agree', label: 'I agree', ...filled('false') });
    const box = row({ field_type: 'CHECKBOX', label: 'Extra', condition: { trigger_key: 'agree', when: 'checked' } });
    const ack = row({ field_type: 'ACKNOWLEDGEMENT', page_number: 1, condition: { trigger_key: 'agree', when: 'checked' } });
    const date = row({ field_type: 'DATE', label: 'Start', condition: { trigger_key: 'agree', when: 'checked' } });
    const text = row({ field_type: 'TEXT', condition: { trigger_key: 'agree', when: 'checked' } });
    const sig = row({ field_type: 'SIGNATURE', page_number: 2, condition: { trigger_key: 'agree', when: 'checked' } });
    const ra = row({ field_type: 'RADIO', group_key: 'tier', label: 'A', condition: { trigger_key: 'agree', when: 'checked' } });
    const rb = row({ field_type: 'RADIO', group_key: 'tier', label: 'B', condition: { trigger_key: 'agree', when: 'checked' } });
    const shownDate = row({ field_type: 'DATE', label: 'End', ...filled('2026-03-04') });
    const all = [trigger, box, ack, date, text, sig, ra, rb, shownDate];
    const hidden = hiddenFieldIds(all);
    const shown = shownOnly(all, hidden);

    expect(radioGroupLines(shown, 's1')).toEqual([]);
    expect(fieldValueLines(shown, 's1', null)).toEqual(['"End": 03/04/2026']);
    expect(hiddenFieldLines(all, 's1', hidden)).toEqual([
      `Checkbox "Extra": ${NOT_SHOWN}`,
      `Acknowledgement (page 2): ${NOT_SHOWN}`,
      `"Start": ${NOT_SHOWN}`,
      `Text (page 1): ${NOT_SHOWN}`,
      `Signature (page 3): ${NOT_SHOWN}`,
      `Radio group "tier": ${NOT_SHOWN}`,
    ]);
    expect(NOT_SHOWN).toBe('not shown (its condition was not met)');
    expect(hiddenFieldLines(all, 's2', hidden)).toEqual([]);
  });

  it('a hidden option of an otherwise shown radio group is listed by itself; the group line reads the shown options', () => {
    const trigger = row({ field_type: 'CHECKBOX', field_key: 'agree', ...filled('false') });
    const ra = row({ field_type: 'RADIO', group_key: 'tier', label: 'A', ...filled('true') });
    const rb = row({ field_type: 'RADIO', group_key: 'tier', label: 'B', condition: { trigger_key: 'agree', when: 'checked' } });
    const all = [trigger, ra, rb];
    const hidden = hiddenFieldIds(all);
    expect(radioGroupLines(shownOnly(all, hidden), 's1')).toEqual(['Radio group "tier": "A"']);
    expect(hiddenFieldLines(all, 's1', hidden)).toEqual([`"B": ${NOT_SHOWN}`]);
  });

  it('certificateBlocks: hidden lines sit after the value lines, once per field; no conditions = no change', async () => {
    const trigger = row({ field_type: 'CHECKBOX', field_key: 'agree', label: 'I agree', ...filled('false') });
    const box = row({ field_type: 'CHECKBOX', label: 'Extra', condition: { trigger_key: 'agree', when: 'checked' } });
    const shownDate = row({ field_type: 'DATE', label: 'End', ...filled('2026-03-04') });
    const blocks = await certificateTexts([trigger, box, shownDate]);
    const signer = blocks.slice(blocks.indexOf('Jane <j***@example.com> — SIGNED'), blocks.indexOf('Evidence'));
    expect(signer).toEqual([
      'Jane <j***@example.com> — SIGNED',
      'Checkbox "I agree": not checked',
      '"End": 03/04/2026',
      `Checkbox "Extra": ${NOT_SHOWN}`,
    ]);
    expect(blocks.filter((t) => t.includes('"Extra"'))).toHaveLength(1);

    const plain = await certificateTexts([{ ...trigger, field_key: null }, { ...box, condition: null }, shownDate]);
    expect(plain.filter((t) => t.includes(NOT_SHOWN))).toEqual([]);
    expect(plain).toContain('Checkbox "Extra": not checked');
  });
});

// The certificate's text blocks for one signer and the given fields, over stub ledger reads.
async function certificateTexts(fields: Row[]): Promise<string[]> {
  const empty = { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) };
  const prisma = new Proxy({}, { get: () => empty });
  const svc = new ExecutionService(prisma as never, {} as never, {} as never, {} as never);
  const full = {
    subject: 'S',
    completed_at: at,
    signer_date_format: null,
    documents: [{ id: 'd1', fields }],
    signers: [{ id: 's1', name: 'Jane', email: 'jane@example.com', status: 'SIGNED', signed_at: null, role: 'SIGNER', witness_for_signer_id: null, delegated_at: null, access_code_hash: null }],
  };
  const blocksFor = await (svc as unknown as {
    certificateBlocks: (...a: unknown[]) => Promise<(h: string) => RenderBlock[]>;
  }).certificateBlocks('t1', 'e1', full, [], new Map(), new Map(), null);
  return blocksFor('h').map((b) => ('text' in b ? String(b.text) : ''));
}
