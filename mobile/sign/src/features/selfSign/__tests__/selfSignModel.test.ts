// M-A12 W1-A / W1-B — the self-sign document list and the values each placed field shows
// and sends (pre-filled from the user's own profile, editable).
import type { EditorField } from '../../editor/editorReducer';
import { ACK_TEXT, RADIO_MARK, type SigningField } from '../../signing/signingMachine';
import {
  canFinish,
  chooseRadio,
  displayFill,
  docMenu,
  fillValue,
  matchServerFields,
  moveDoc,
  pageCountLabel,
  placedOnServer,
  removeDoc,
  renameDoc,
  SELF_COPY,
  selfSubject,
  type SelfContext,
  type SelfDoc,
} from '../selfSignModel';

const PAGE = { width: 612, height: 792 };
const doc = (key: string, over: Partial<SelfDoc> = {}): SelfDoc => ({
  key,
  title: `Doc ${key}`,
  filename: `${key}.pdf`,
  base64: 'JVBERi0=',
  pages: [PAGE, PAGE],
  serverId: null,
  ...over,
});
const field = (key: string, type: EditorField['type'], over: Partial<EditorField> = {}): EditorField => ({
  key,
  docKey: 'a',
  page: 0,
  recipientKey: 'self',
  type,
  x: 100,
  y: 100,
  width: 200,
  height: 22,
  required: true,
  ...over,
});
const MARK = { dataUrl: 'data:image/png;base64,AAA', method: 'TYPED' as const, value: 'Priya Raman' };
const ctx = (over: Partial<SelfContext> = {}): SelfContext => ({
  profile: { display_name: 'Priya Raman', company: 'Northwind', title: 'Recruiter' },
  email: 'priya@example.com',
  fallbackName: 'Account Name',
  dateFormat: 'DD/MM/YYYY',
  adopted: { SIGNATURE: MARK },
  today: new Date(2026, 10, 5),
  ...over,
});

describe('W1-B documents', () => {
  it('page count for every document; unknown counts are omitted', () => {
    expect(pageCountLabel([PAGE])).toBe('1 page');
    expect(pageCountLabel([PAGE, PAGE, PAGE])).toBe('3 pages');
    expect(pageCountLabel(null)).toBeNull();
  });

  it('rename, move up / down and remove', () => {
    const docs = [doc('a'), doc('b'), doc('c')];
    expect(renameDoc(docs, 'b', '  Offer  ').map((d) => d.title)).toEqual(['Doc a', 'Offer', 'Doc c']);
    expect(renameDoc(docs, 'b', '   ')[1]?.title).toBe('Doc b');
    expect(moveDoc(docs, 'b', -1).map((d) => d.key)).toEqual(['b', 'a', 'c']);
    expect(moveDoc(docs, 'c', 1).map((d) => d.key)).toEqual(['a', 'b', 'c']);
    expect(removeDoc(docs, 'a').map((d) => d.key)).toEqual(['b', 'c']);
    expect(selfSubject(docs)).toBe('Doc a and 2 more');
  });

  it('rename and reorder apply until uploaded; remove always', () => {
    const docs = [doc('a', { serverId: 's1' }), doc('b'), doc('c')];
    expect(docMenu(docs, 'a')).toEqual({ rename: false, up: false, down: false, remove: true });
    expect(docMenu(docs, 'b')).toEqual({ rename: true, up: false, down: true, remove: true });
    expect(docMenu(docs, 'c')).toEqual({ rename: true, up: true, down: false, remove: true });
  });
});

describe('W1-A values', () => {
  it('fills placed fields at once: signature, date in the user format, profile fields', () => {
    expect(displayFill(field('s', 'SIGNATURE'), ctx(), {})).toEqual({ kind: 'image', uri: MARK.dataUrl });
    expect(displayFill(field('d', 'SIGN_DATE'), ctx(), {})).toEqual({ kind: 'text', text: '05/11/2026' });
    expect(displayFill(field('f', 'FIRST_NAME'), ctx(), {})).toEqual({ kind: 'text', text: 'Priya' });
    expect(displayFill(field('l', 'LAST_NAME'), ctx(), {})).toEqual({ kind: 'text', text: 'Raman' });
    expect(displayFill(field('e', 'EMAIL'), ctx(), {})).toEqual({ kind: 'text', text: 'priya@example.com' });
    expect(displayFill(field('c', 'COMPANY'), ctx(), {})).toEqual({ kind: 'text', text: 'Northwind' });
    expect(displayFill(field('t', 'TITLE'), ctx(), {})).toEqual({ kind: 'text', text: 'Recruiter' });
    expect(displayFill(field('x', 'TEXT'), ctx(), {})).toBeNull();
  });

  it('the user can edit a pre-filled value', () => {
    expect(displayFill(field('c', 'COMPANY'), ctx(), { c: 'Acme' })).toEqual({ kind: 'text', text: 'Acme' });
    expect(fillValue(field('c', 'COMPANY'), ctx(), { c: ' Acme ' })).toEqual({ value: 'Acme' });
  });

  it('falls back to the account name when the profile has none', () => {
    expect(displayFill(field('f', 'FIRST_NAME'), ctx({ profile: null }), {})).toEqual({ kind: 'text', text: 'Account' });
  });

  // Field-test batch 1 SIG-6 — the one shared rule: local self-sign keeps filling on open,
  // without the name field (M-A6, D-3); a single-word name leaves the last name empty.
  it('never fills a typed name field; a single word is the first name only', () => {
    const typedName = field('n', 'SIGNER_NAME', { nameMode: 'SIGNER_ENTERED' } as Partial<EditorField>);
    expect(displayFill(typedName, ctx(), {})).toBeNull();
    expect(fillValue(typedName, ctx(), {})).toBeNull();
    const single = ctx({ profile: { display_name: 'Priya' } as SelfContext['profile'] });
    expect(displayFill(field('f', 'FIRST_NAME'), single, {})).toEqual({ kind: 'text', text: 'Priya' });
    expect(displayFill(field('l', 'LAST_NAME'), single, {})).toBeNull();
  });

  it('sends ISO dates, the adopted mark, check states; never a server-filled name', () => {
    expect(fillValue(field('d', 'SIGN_DATE'), ctx(), {})).toEqual({ value: '2026-11-05' });
    // M-A13 #1 — a TYPED mark sends its text; the page still shows the script PNG.
    expect(fillValue(field('s', 'SIGNATURE'), ctx(), {})).toEqual({ value: 'Priya Raman', method: 'TYPED' });
    expect(fillValue(field('k', 'CHECKBOX'), ctx(), {})).toEqual({ value: 'true' });
    expect(fillValue(field('k', 'CHECKBOX'), ctx(), { k: 'false' })).toEqual({ value: 'false' });
    expect(fillValue(field('n', 'SIGNER_NAME'), ctx(), {})).toBeNull();
  });

  it('Finish needs a signature and every required value', () => {
    expect(canFinish([field('t', 'TEXT')], ctx(), {})).toMatchObject({ ok: false, message: SELF_COPY.needSignature });
    expect(canFinish([field('s', 'SIGNATURE')], ctx({ adopted: {} }), {})).toMatchObject({ ok: false });
    expect(canFinish([field('s', 'SIGNATURE'), field('t', 'TEXT')], ctx(), {})).toMatchObject({
      ok: false,
      message: SELF_COPY.needValues,
      fieldKey: 't',
    });
    expect(canFinish([field('s', 'SIGNATURE'), field('t', 'TEXT')], ctx(), { t: 'x' }).ok).toBe(true);
  });

  it('FIELD-PARITY-2 A-1 — a required carried field this screen cannot fill blocks Finish', () => {
    const placed = [field('s', 'SIGNATURE')];
    expect(canFinish(placed, ctx(), {}, [{ field_type: 'TEXT', required: true, signer_id: 'r-self' }])).toMatchObject({
      ok: false,
      message: SELF_COPY.cannotFill,
    });
    expect(canFinish(placed, ctx(), {}, [{ field_type: 'TEXT', required: false, signer_id: 'r-self' }]).ok).toBe(true);
    expect(canFinish(placed, ctx(), {}, [{ field_type: 'TEXT', required: true, signer_id: null }]).ok).toBe(true);
  });
});

describe('FIELD-PARITY-2 A-1 — the Phase 3 types in Sign a document', () => {
  const sig = field('s', 'SIGNATURE');
  const drop = field('d', 'DROPDOWN', { options: { choices: [{ value: 'a', label: 'Plan A' }, { value: 'b', label: 'Plan B' }] } });
  const date = field('t', 'DATE');
  const num = field('n', 'NUMBER', { options: { format: 'money', currency: 'USD', decimals: 2 } });
  const ml = field('m', 'MULTILINE_TEXT', { required: false });
  const ack = field('k', 'ACKNOWLEDGEMENT');
  const yes = field('y', 'RADIO', { groupKey: 'g', label: 'Yes' });
  const no = field('o', 'RADIO', { groupKey: 'g', label: 'No' });

  it('shows each value as the executed PDF prints it', () => {
    const edits = { d: 'b', t: '2026-03-04', n: '1250.5', m: 'line 1\nline 2', k: 'true', y: 'true' };
    expect(displayFill(drop, ctx(), edits)).toEqual({ kind: 'text', text: 'Plan B' });
    expect(displayFill(date, ctx(), edits)).toEqual({ kind: 'text', text: '04/03/2026' });
    expect(displayFill(num, ctx(), edits)).toEqual({ kind: 'text', text: '$1,250.50' });
    expect(displayFill(ml, ctx(), edits)).toEqual({ kind: 'text', text: 'line 1\nline 2' });
    expect(displayFill(ack, ctx(), edits)).toEqual({ kind: 'text', text: ACK_TEXT });
    expect(displayFill(yes, ctx(), edits)).toEqual({ kind: 'text', text: RADIO_MARK });
    expect(displayFill(no, ctx(), edits)).toBeNull();
    expect(displayFill(drop, ctx(), {})).toBeNull();
  });

  it('sends the stored values; an option or acknowledgement only when on', () => {
    const edits = { d: 'b', t: '2026-03-04', n: '1250.5', y: 'true', o: 'false' };
    expect(fillValue(drop, ctx(), edits)).toEqual({ value: 'b' });
    expect(fillValue(date, ctx(), edits)).toEqual({ value: '2026-03-04' });
    expect(fillValue(num, ctx(), edits)).toEqual({ value: '1250.5' });
    expect(fillValue(ml, ctx(), edits)).toBeNull();
    expect(fillValue(ack, ctx(), edits)).toBeNull();
    expect(fillValue(yes, ctx(), edits)).toEqual({ value: 'true' });
    expect(fillValue(no, ctx(), edits)).toBeNull();
  });

  it('a sender-filled template field shows its value and is never sent', () => {
    const locked = field('l', 'TEXT', { senderFilled: true, readOnly: true, senderValue: 'ACME-42' });
    expect(displayFill(locked, ctx(), {})).toEqual({ kind: 'text', text: 'ACME-42' });
    expect(fillValue(locked, ctx(), {})).toBeNull();
    expect(canFinish([sig, locked], ctx(), {}).ok).toBe(true);
  });

  it('choosing a radio option clears the others of its group', () => {
    const e1 = chooseRadio([yes, no], yes, {});
    expect(e1).toEqual({ y: 'true', o: 'false' });
    expect(chooseRadio([yes, no], no, e1)).toEqual({ y: 'false', o: 'true' });
    // A-2 — the chosen option of a required set stays chosen; of an optional set it clears.
    expect(chooseRadio([yes, no], yes, e1)).toEqual(e1);
    const a = { ...yes, required: false };
    const b = { ...no, required: false };
    expect(chooseRadio([a, b], a, e1)).toEqual({ y: 'false', o: 'false' });
  });

  it('Finish follows the shared completion rule (required values, acknowledgement, radio group)', () => {
    const all = [sig, drop, date, num, ml, ack, yes, no];
    const full = { d: 'a', t: '2026-03-04', n: '5', k: 'true', y: 'true' };
    expect(canFinish(all, ctx(), full).ok).toBe(true);
    expect(canFinish(all, ctx(), { ...full, d: '' })).toMatchObject({ ok: false, message: SELF_COPY.needValues, fieldKey: 'd' });
    expect(canFinish(all, ctx(), { ...full, k: 'false' })).toMatchObject({ ok: false, fieldKey: 'k' });
    expect(canFinish(all, ctx(), { ...full, y: 'false' })).toMatchObject({ ok: false, fieldKey: 'y' });
    // An optional multi-line field may stay empty; a required check box left unticked blocks.
    expect(canFinish([sig, field('c', 'CHECKBOX')], ctx(), { c: 'false' })).toMatchObject({ ok: false, fieldKey: 'c' });
  });
});

describe('matching the server fields to the placed fields', () => {
  it('pairs by document, page, type and nearest position', () => {
    const docs = [doc('a', { serverId: 'srv-a' })];
    const fields = [field('s1', 'SIGNATURE', { y: 100 }), field('s2', 'SIGNATURE', { y: 600 })];
    const placed = placedOnServer(fields, docs);
    const server = (id: string, y: number): SigningField => ({
      field_id: id,
      document_id: 'srv-a',
      field_type: 'SIGNATURE',
      page_number: 0,
      x: 100,
      y,
      width: 200,
      height: 22,
      required: true,
    });
    // PDF y is bottom-up: the field placed lower on the page has the smaller y.
    const pairs = matchServerFields([server('B', 792 - 600 - 22), server('A', 792 - 100 - 22)], placed);
    expect(pairs.map((p) => [p.server.field_id, p.field?.key])).toEqual([
      ['B', 's2'],
      ['A', 's1'],
    ]);
    expect(matchServerFields([{ ...server('C', 0), field_type: 'TEXT' }], placed)[0]?.field).toBeNull();
  });
});
