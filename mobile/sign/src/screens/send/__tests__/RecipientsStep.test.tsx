import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useSyncExternalStore } from 'react';

import { createDraftStore } from '../../../state/draftStore';
import { createEncryptedStore } from '../../../state/encryptedStore';
import { memoryFiles, memoryKv, nodeAesGcm } from '../../../testing/fakes';
import { createDocumentBytesStore } from '../../../features/send/documentBytes';
import type { SenderApi } from '../../../features/send/senderApi';
import { SendFlowController } from '../../../features/send/sendFlowController';
import {
  ALREADY_RECIPIENT,
  RECIPIENTS_FULL,
  RecipientsStep,
  assignToMe,
  routingFootnote,
} from '../RecipientsStep';
import { sentToast } from '../../../features/send/sendCopy';

// The contacts sheet talks to the server; it is covered by its own tests.
jest.mock('../../../features/contacts/ContactsSheet', () => ({ ContactsSheet: () => null }));

function controller() {
  const store = createEncryptedStore({ kv: memoryKv(), cipher: nodeAesGcm, files: memoryFiles() });
  let n = 0;
  return new SendFlowController({
    drafts: createDraftStore(store),
    bytes: createDocumentBytesStore(store),
    api: {} as SenderApi,
    fetchSource: async () => new Uint8Array(),
    isOnline: () => true,
    newId: () => `id-${String(++n).padStart(8, '0')}`,
  });
}

const ME = { name: 'Priya Nair', email: 'priya@northwind.example' };

function Harness({
  c,
  me = null,
  roles = false,
  inPerson = false,
}: {
  readonly c: SendFlowController;
  readonly me?: { readonly name: string; readonly email: string } | null;
  readonly roles?: boolean;
  readonly inPerson?: boolean;
}) {
  const state = useSyncExternalStore(c.subscribe, () => c.snapshot);
  return (
    <RecipientsStep controller={c} state={state} me={me} online roles={roles} inPerson={inPerson} />
  );
}

describe('Recipients step (handoff §4.6, directive §7 C-1 / C-11)', () => {
  it('without the role chips (flag off) shows no role choice at all', async () => {
    const c = controller();
    await c.open();
    c.addRecipient({ name: 'Dana Lee', email: 'dana@example.com' });
    c.addRecipient({ name: 'Sam Roy', email: 'sam@example.com' });
    render(<Harness c={c} />);
    expect(screen.getByText('Who needs to sign?')).toBeTruthy();
    expect(screen.getByText('Dana Lee')).toBeTruthy();
    expect(screen.queryByText(/copy/i)).toBeNull();
    expect(screen.queryByText(/\bcc\b/i)).toBeNull();
    expect(screen.queryByText(/^Signs$/)).toBeNull(); // no Signs / Gets a copy toggle
    expect(screen.queryByLabelText(/copy/i)).toBeNull();
  });

  it('shows the parallel footnote only for parallel routing, and reorders when sequential', async () => {
    const c = controller();
    await c.open();
    c.addRecipient({ name: 'Dana Lee', email: 'dana@example.com' });
    c.addRecipient({ name: 'Sam Roy', email: 'sam@example.com' });
    render(<Harness c={c} />);
    expect(screen.getByText(routingFootnote('PARALLEL'))).toBeTruthy();
    expect(screen.queryByLabelText('Move Sam Roy up')).toBeNull();
    await act(async () => c.setRouting('SEQUENTIAL'));
    expect(screen.queryByText('Everyone signs at the same time.')).toBeNull();
    fireEvent.press(screen.getByLabelText('Move Sam Roy up'));
    expect(c.snapshot.draft!.payload.recipients.map((r) => r.name)).toEqual(['Sam Roy', 'Dana Lee']);
  });

  it('removes a recipient', async () => {
    const c = controller();
    await c.open();
    c.addRecipient({ name: 'Dana Lee', email: 'dana@example.com' });
    render(<Harness c={c} />);
    fireEvent.press(screen.getByLabelText('Remove Dana Lee'));
    expect(c.snapshot.draft!.payload.recipients).toHaveLength(0);
  });

  it('confirms the send with the signer count', () => {
    expect(sentToast(1)).toBe('Sent to 1 signer');
    expect(sentToast(3)).toBe('Sent to 3 signers');
  });
});

describe('Assign to me (M-A4 §6.1)', () => {
  it('adds the signed-in user as a signer', async () => {
    const c = controller();
    await c.open();
    render(<Harness c={c} me={ME} />);
    fireEvent.press(screen.getByTestId('assign-to-me'));
    expect(c.snapshot.draft!.payload.recipients.map((r) => [r.name, r.email])).toEqual([
      ['Priya Nair', 'priya@northwind.example'],
    ]);
    expect(screen.getByText(/Priya Nair/)).toBeTruthy();
    expect(screen.getByText(/\(you\)/)).toBeTruthy();
    // Assign to me binds the recipient (M-A5 §4.1).
    expect(c.snapshot.draft!.payload.recipients[0]!.assignToMe).toBe(true);
  });

  it('refuses a duplicate with the same email check as other recipients (case-insensitive)', async () => {
    const c = controller();
    await c.open();
    c.addRecipient({ name: 'Priya', email: 'PRIYA@northwind.example' });
    render(<Harness c={c} me={ME} />);
    fireEvent.press(screen.getByTestId('assign-to-me'));
    expect(c.snapshot.draft!.payload.recipients).toHaveLength(1);
    expect(screen.getByText(ALREADY_RECIPIENT)).toBeTruthy();
  });

  it('refuses when the envelope is full', async () => {
    const c = controller();
    await c.open();
    for (let i = 0; i < 10; i += 1) c.addRecipient({ name: `P${i}`, email: `p${i}@example.com` });
    expect(assignToMe(c, ME)).toBe(RECIPIENTS_FULL);
    expect(c.snapshot.draft!.payload.recipients).toHaveLength(10);
  });

  it('is not shown without a signed-in user email', async () => {
    const c = controller();
    await c.open();
    render(<Harness c={c} />);
    expect(screen.queryByTestId('assign-to-me')).toBeNull();
  });
});

describe('Role chips Signs · In person · Copy (M-A5 §1, §2; prototype step 2)', () => {
  it('renders the three chips per recipient; In person only while hosting is available', async () => {
    const c = controller();
    await c.open();
    c.addRecipient({ name: 'Dana Lee', email: 'dana@example.com' });
    const key = c.snapshot.draft!.payload.recipients[0]!.key;
    const view = render(<Harness c={c} roles inPerson />);
    expect(screen.getByTestId(`role-${key}-SIGNER`)).toBeTruthy();
    expect(screen.getByTestId(`role-${key}-IN_PERSON_SIGNER`)).toBeTruthy();
    expect(screen.getByTestId(`role-${key}-RECEIVES_COPY`)).toBeTruthy();
    expect(screen.getByLabelText('Signs, Dana Lee').props.accessibilityState).toEqual({
      selected: true,
    });
    view.rerender(<Harness c={c} roles inPerson={false} />);
    expect(screen.queryByTestId(`role-${key}-IN_PERSON_SIGNER`)).toBeNull();
  });

  it('Copy moves the recipient to "Receives a copy" with a timing choice', async () => {
    const c = controller();
    await c.open();
    c.addRecipient({ name: 'Dana Lee', email: 'dana@example.com' });
    c.addRecipient({ name: 'Sam Roy', email: 'sam@example.com' });
    const sam = c.snapshot.draft!.payload.recipients[1]!.key;
    render(<Harness c={c} roles inPerson />);
    expect(screen.queryByText('Receives a copy')).toBeNull();
    fireEvent.press(screen.getByTestId(`role-${sam}-RECEIVES_COPY`));
    expect(screen.getByText('Receives a copy')).toBeTruthy();
    expect(screen.getByText('When sent')).toBeTruthy();
    expect(screen.getByText('Both')).toBeTruthy();
    fireEvent.press(screen.getByTestId(`timing-${sam}-ON_SEND`));
    expect(c.snapshot.draft!.payload.recipients[1]).toMatchObject({
      kind: 'RECEIVES_COPY',
      copyDelivery: 'ON_SEND',
    });
    // One signer left: no routing control (copies are never part of the order).
    expect(screen.queryByTestId('routing-SEQUENTIAL')).toBeNull();
  });

  it('adds a name-only in-person signer (email optional)', async () => {
    const c = controller();
    await c.open();
    render(<Harness c={c} roles inPerson />);
    fireEvent.press(screen.getByTestId('add-in-person'));
    fireEvent.changeText(screen.getByTestId('in-person-name'), 'Walk In');
    fireEvent.press(screen.getByTestId('in-person-add'));
    expect(c.snapshot.draft!.payload.recipients[0]).toMatchObject({
      name: 'Walk In',
      email: '',
      kind: 'IN_PERSON_SIGNER',
    });
    expect(screen.getByText('No email · signs on this device')).toBeTruthy();
  });

  it('shows the server-mirrored reason when a change is refused', async () => {
    const c = controller();
    await c.open();
    c.addRecipient({ name: 'Walk In', email: '' }, 'IN_PERSON_SIGNER');
    const key = c.snapshot.draft!.payload.recipients[0]!.key;
    render(<Harness c={c} roles inPerson />);
    fireEvent.press(screen.getByTestId(`role-${key}-RECEIVES_COPY`));
    expect(screen.getByText('Add an email address for this person, or choose In person.')).toBeTruthy();
  });
});
