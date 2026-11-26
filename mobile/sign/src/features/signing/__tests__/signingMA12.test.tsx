// M-A12 W1-C — signing: "Page n of N", the header overflow "…" (Find, Document details,
// Decline, Ask someone else to sign, Help), Find on the signer text layer (token
// transport) with "No searchable text in this document", and the profile field types
// (field-test batch 1 SIG-11 + A1: Email pre-filled on open, the profile values offered).
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { createGuestSigningClient } from '../../../api/guestSigningClient';
import { ServicesProvider } from '../../../app/ServicesContext';
import type { AppServices } from '../../../app/services';
import { ToastProvider } from '../../../components/Toast';
import { memoryKv, recordingFetch, SIGNING_TOKEN } from '../../../testing/fakes';
import { workspaceWith } from '../../inbox/__tests__/fixtures';
import { SigningFlow } from '../SigningFlow';
import { PROFILE_OFFER_COPY } from '@aramo/sign-client';

import { submitSigning, saveAnswers } from '../signingApi';
import {
  attemptFinish,
  canFinish,
  fillsToSubmit,
  initialState,
  markSaved,
  profileOfferOf,
  profileOffersOf,
  setText,
  takeProfileOffer,
  takeProfileOffers,
  tapField,
  type SigningField,
} from '../signingMachine';

jest.mock('react-native-pdf', () => 'Pdf');
jest.mock('react-native-view-shot', () => ({ captureRef: jest.fn() }));
jest.setTimeout(30_000);

const BASE = 'https://sign.aramo.ai';
const PDF_B64 = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj\n' +
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\n4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\ntrailer << /Root 1 0 R >>\nstartxref\n0\n%%EOF\n',
  'latin1',
).toString('base64');

function wrap(children: ReactNode) {
  const { workspace } = workspaceWith(() => ({ status: 200, body: {} }));
  const services = { kv: memoryKv(), workspace } as unknown as AppServices;
  return (
    <ServicesProvider services={services}>
      <ToastProvider>{children}</ToastProvider>
    </ServicesProvider>
  );
}

function signer(textLayerWords: unknown[] = [], view: { fields?: unknown[]; profile_prefill?: unknown } = {}) {
  return recordingFetch((req) => {
    if (req.url.endsWith('/disclosure-text'))
      return { status: 200, body: { disclosure_version: '1.0', text: 'T', text_sha256: 'c'.repeat(64), message: null } };
    if (req.url.endsWith('/signing/document'))
      return {
        status: 200,
        body: { documents: [{ document_id: 'doc-1', title: 'Offer', ordinal: 1 }], fields: view.fields ?? [], message: null, can_delegate: true, profile_prefill: view.profile_prefill ?? null },
      };
    if (req.url.endsWith('/fill')) return { status: 200, body: { filled: true } };
    if (req.url.endsWith('/signing/complete')) return { status: 200, body: { envelope_status: 'COMPLETED' } };
    if (req.url.endsWith('/signing/source')) return { status: 200, body: { source_base64: PDF_B64, content_type: 'application/pdf' } };
    if (req.url.endsWith('/text-layer')) return { status: 200, body: { document_id: 'doc-1', pages: [{ page: 1, words: textLayerWords }] } };
    return { status: 200, body: {} };
  });
}

async function openFields(net: ReturnType<typeof signer>) {
  const session = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(SIGNING_TOKEN);
  render(wrap(<SigningFlow session={session} signerName="" signedIn={false} subject="Offer" senderName="Northwind" onDone={jest.fn()} />));
  await waitFor(() => expect(screen.getByTestId('consent-check')).toBeTruthy(), { timeout: 15_000 });
  fireEvent.press(screen.getByTestId('consent-check'));
  fireEvent.press(screen.getByTestId('consent-continue'));
  await waitFor(() => expect(screen.getByTestId('signing-primary')).toBeTruthy(), { timeout: 15_000 });
}

describe('signing (M-A12 W1-C)', () => {
  it('shows "Page n of N" with up / down arrows', async () => {
    await openFields(signer());
    await waitFor(() => expect(screen.getByTestId('page-label')).toBeTruthy());
    expect(screen.getByTestId('page-label').props.children).toBe('Page 1 of 2');
    expect(screen.getByTestId('page-prev').props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(screen.getByTestId('page-next'));
    expect(screen.getByTestId('page-label').props.children).toBe('Page 2 of 2');
  });

  it('the overflow menu has Find, Document details, Decline, Ask someone else to sign, Help', async () => {
    await openFields(signer());
    fireEvent.press(screen.getByTestId('signing-more'));
    for (const id of ['more-find', 'more-details', 'more-decline', 'delegate-open', 'more-help'])
      expect(screen.getByTestId(id)).toBeTruthy();
  });

  it('Find reads the signer text layer on the token transport; an image-only PDF says so', async () => {
    const net = signer([]);
    await openFields(net);
    fireEvent.press(screen.getByTestId('signing-more'));
    fireEvent.press(screen.getByTestId('more-find'));
    await waitFor(() =>
      expect(screen.getByTestId('find-status').props.children).toBe('No searchable text in this document'),
    );
    const call = net.calls.find((c) => c.url.endsWith('/v1/sign/signing/documents/doc-1/text-layer'));
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual({ token: SIGNING_TOKEN });
  });

  it('Find counts matches and steps through them', async () => {
    await openFields(signer([{ t: 'Offer', x: 0.1, y: 0.1, w: 0.1, h: 0.02 }, { t: 'offer', x: 0.3, y: 0.1, w: 0.1, h: 0.02 }]));
    fireEvent.press(screen.getByTestId('signing-more'));
    fireEvent.press(screen.getByTestId('more-find'));
    fireEvent.changeText(screen.getByTestId('find-input'), 'offer');
    await waitFor(() => expect(screen.getByTestId('find-status').props.children).toBe('1 of 2'));
    fireEvent.press(screen.getByTestId('find-next'));
    expect(screen.getByTestId('find-status').props.children).toBe('2 of 2');
  });
});

// Field-test batch 1 §2 SIG-11, as amended by A1 (A1-7): the server's profile_prefill on a
// signed-in session. Email (sender-held) is pre-filled on open; Company, Title and the names are
// offers that move only on the signer's tap; an offer not taken is never sent.
describe('profile field types (SIG-11 + A1)', () => {
  const f = (type: string, over: Partial<SigningField> = {}): SigningField => ({
    field_id: type,
    document_id: 'doc-1',
    field_type: type,
    page_number: 0,
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    required: false,
    ...over,
  });
  const PREFILL = { FIRST_NAME: 'Priya', LAST_NAME: 'Raman', EMAIL: 'priya@example.com', COMPANY: 'Northwind', TITLE: 'Recruiter' };
  const PROFILE_VALUES = ['Priya', 'Raman', 'Northwind', 'Recruiter'];
  const all = () => ['FIRST_NAME', 'LAST_NAME', 'EMAIL', 'COMPANY', 'TITLE'].map((t) => f(t));

  it('on open: Email is pre-filled with the recipient email; Company and Title are empty and offered', () => {
    const s = initialState(all(), [], null, PREFILL);
    expect(s.values['EMAIL']).toEqual({ value: 'priya@example.com' });
    for (const t of ['FIRST_NAME', 'LAST_NAME', 'COMPANY', 'TITLE']) expect(s.values[t]).toBeUndefined();
    expect(profileOffersOf(s).map((o) => [o.field.field_id, o.value])).toEqual([
      ['FIRST_NAME', 'Priya'],
      ['LAST_NAME', 'Raman'],
      ['COMPANY', 'Northwind'],
      ['TITLE', 'Recruiter'],
    ]);
    // A profile field opens its sheet empty: the offer is a hint, never the starting value.
    expect(tapField(s, 'COMPANY', { signerName: '' }).effect).toEqual({ kind: 'text', fieldId: 'COMPANY', initial: '' });
    expect(profileOfferOf(s, 'COMPANY')).toBe('Northwind');
  });

  it('"Fill from my profile" fills only empty, visible, editable fields; the values stay editable', () => {
    const fields = [
      f('COMPANY'),
      f('TITLE', { filled: true, value: 'Typed title' }),
      f('FIRST_NAME', { read_only: true, value: 'Sender set' }),
      f('LAST_NAME', { condition: { trigger_key: 'k', when: 'checked' } }),
      f('CHECKBOX', { field_key: 'k' }),
    ];
    const { state, count } = takeProfileOffers(initialState(fields, [], null, PREFILL));
    expect(count).toBe(1);
    expect(state.values['COMPANY']).toEqual({ value: 'Northwind' });
    expect(state.values['TITLE']).toMatchObject({ value: 'Typed title', fromServer: true });
    expect(state.values['FIRST_NAME']).toMatchObject({ value: 'Sender set', fromServer: true });
    expect(state.values['LAST_NAME']).toBeUndefined();
    // Taken values are ordinary answers: editable and saved through the normal fill.
    expect(fillsToSubmit(state)).toEqual([{ fieldId: 'COMPANY', value: 'Northwind' }]);
    expect(setText(state, 'COMPANY', 'Acme').values['COMPANY']).toEqual({ value: 'Acme' });
    // No offer is left: the banner goes away.
    expect(profileOffersOf(state)).toEqual([]);
  });

  it('a field that becomes visible later is offered, never filled automatically', () => {
    const fields = [f('LAST_NAME', { condition: { trigger_key: 'k', when: 'checked' } }), f('CHECKBOX', { field_key: 'k' })];
    let s = initialState(fields, [], null, PREFILL);
    expect(profileOfferOf(s, 'LAST_NAME')).toBeNull();
    s = tapField(s, 'CHECKBOX', { signerName: '' }).state;
    expect(s.values['LAST_NAME']).toBeUndefined();
    expect(profileOfferOf(s, 'LAST_NAME')).toBe('Raman');
  });

  it('one field’s hint fills only that field', () => {
    const s = takeProfileOffer(initialState(all(), [], null, PREFILL), 'TITLE');
    expect(s.values['TITLE']).toEqual({ value: 'Recruiter' });
    expect(s.values['COMPANY']).toBeUndefined();
  });

  it('LEAK REGRESSION — Finish with offers not taken sends no profile value (save as you go neither)', async () => {
    const net = recordingFetch((req) => (req.url.endsWith('/complete') ? { status: 200, body: { envelope_status: 'COMPLETED' } } : { status: 200, body: { filled: true } }));
    const session = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(SIGNING_TOKEN);
    let s = initialState(all(), [], null, PREFILL);
    await saveAnswers(session, s, (x) => (s = markSaved(s, x)));
    await submitSigning(session, initialState(all(), [], null, PREFILL), () => undefined);
    const bodies = JSON.stringify(net.calls.map((c) => c.body));
    for (const v of PROFILE_VALUES) expect(bodies).not.toContain(v);
    expect(net.calls.filter((c) => c.url.endsWith('/fill')).map((c) => c.url.replace(BASE, ''))).toEqual([
      '/v1/sign/signing/fields/EMAIL/fill',
      '/v1/sign/signing/fields/EMAIL/fill',
    ]);
  });

  it('a required Company field blocks Finish until a value is entered or taken', () => {
    const s = initialState([f('COMPANY', { required: true })], [], null, PREFILL);
    expect(canFinish(s)).toBe(false);
    expect(attemptFinish(s).blocked).toBe(true);
    expect(canFinish(takeProfileOffer(s, 'COMPANY'))).toBe(true);
    expect(canFinish(setText(s, 'COMPANY', 'Typed Co'))).toBe(true);
  });

  it('no profile_prefill (an emailed link, a hosted session, a guest): nothing pre-filled, no offers', () => {
    const s = initialState(all(), [], null, null);
    expect(s.values).toEqual({});
    expect(profileOffersOf(s)).toEqual([]);
    expect(profileOfferOf(s, 'COMPANY')).toBeNull();
  });

  it('the signing page: the banner fills in one tap; the sheet shows one field’s hint', async () => {
    const net = signer([], { fields: [f('EMAIL'), f('COMPANY'), f('TITLE')], profile_prefill: PREFILL });
    await openFields(net);
    expect(screen.getByText(PROFILE_OFFER_COPY.banner)).toBeTruthy();
    // The sheet of an empty profile field offers its value; nothing is filled yet.
    fireEvent.press(screen.getByTestId('field-TITLE'));
    expect(screen.getByText(PROFILE_OFFER_COPY.hint('Recruiter'))).toBeTruthy();
    fireEvent.press(screen.getByTestId('profile-offer-hint'));
    await waitFor(() => expect(screen.getByText('Recruiter')).toBeTruthy());
    fireEvent.press(screen.getByTestId('profile-offer-banner'));
    await waitFor(() => expect(screen.getByText(PROFILE_OFFER_COPY.filled(1))).toBeTruthy());
    expect(screen.queryByTestId('profile-offer-banner')).toBeNull();
  });

  it('LEAK REGRESSION (signing page) — Finish without taking the offer sends no profile value', async () => {
    const net = signer([], { fields: [f('EMAIL', { required: true }), f('COMPANY'), f('TITLE')], profile_prefill: PREFILL });
    await openFields(net);
    expect(screen.getByText(PROFILE_OFFER_COPY.banner)).toBeTruthy();
    // Email (sender-held) is pre-filled on open, so the one required field is done.
    await waitFor(() => expect(screen.getByText('Finish')).toBeTruthy());
    fireEvent.press(screen.getByText('Finish'));
    await waitFor(() => expect(net.calls.some((c) => c.url.endsWith('/signing/complete'))).toBe(true));
    const sent = JSON.stringify(net.calls.map((c) => c.body));
    for (const v of PROFILE_VALUES) expect(sent).not.toContain(v);
    expect(net.calls.some((c) => c.url.endsWith('/fields/COMPANY/fill') || c.url.endsWith('/fields/TITLE/fill'))).toBe(false);
  });

  it('the signing page without profile_prefill shows no banner', async () => {
    await openFields(signer([], { fields: [f('COMPANY')], profile_prefill: null }));
    expect(screen.queryByTestId('profile-offer-banner')).toBeNull();
    expect(screen.queryByText(PROFILE_OFFER_COPY.banner)).toBeNull();
  });
});
