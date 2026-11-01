// Consolidated Directive v1.0 B2 — each sender option appears only while the sender
// context reports it available, and edits the local draft.
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useSyncExternalStore } from 'react';

import { createDraftStore } from '../../../state/draftStore';
import { createEncryptedStore } from '../../../state/encryptedStore';
import { memoryFiles, memoryKv, nodeAesGcm } from '../../../testing/fakes';
import { createDocumentBytesStore } from '../../../features/send/documentBytes';
import type { SenderApi } from '../../../features/send/senderApi';
import { NO_SEND_FEATURES, type SendFeatures } from '../../../features/send/sendFeatures';
import { SendFlowController } from '../../../features/send/sendFlowController';
import { RecipientsStep } from '../RecipientsStep';
import { ACCESS_CODE_RULE, WITNESS_PICK_HINT } from '../RecipientOptions';

jest.mock('../../../features/contacts/ContactsSheet', () => ({ ContactsSheet: () => null }));

const ALL_ON: SendFeatures = {
  witness: true,
  delegation: true,
  accessCode: true,
  sms: true,
  whatsapp: true,
  smsCode: true,
  idCheck: true,
  kba: true,
};

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

function Harness({ c, features }: { readonly c: SendFlowController; readonly features: SendFeatures }) {
  const state = useSyncExternalStore(c.subscribe, () => c.snapshot);
  return <RecipientsStep controller={c} state={state} me={null} online roles features={features} />;
}

async function twoSigners() {
  const c = controller();
  await c.open();
  c.addRecipient({ name: 'Dana Lee', email: 'dana@example.com' });
  c.addRecipient({ name: 'Wes Tan', email: 'wes@example.com' });
  const [dana, wes] = c.snapshot.draft!.payload.recipients;
  return { c, dana: dana!, wes: wes! };
}

describe('Recipients step — B2 options', () => {
  it('shows none of the options while the context reports them unavailable', async () => {
    const { c, dana } = await twoSigners();
    render(<Harness c={c} features={NO_SEND_FEATURES} />);
    expect(screen.queryByText('Witness')).toBeNull();
    expect(screen.queryByText('Let signers hand off to someone else')).toBeNull();
    expect(screen.queryByText('Add access code')).toBeNull();
    expect(screen.queryByText('Identity check')).toBeNull();
    expect(screen.queryByText('Require an SMS code')).toBeNull();
    expect(screen.queryByText('Email + SMS')).toBeNull();
    expect(screen.queryByTestId(`options-${dana.key}`)).toBeNull();
  });

  it('shows only the available ones', async () => {
    const { c } = await twoSigners();
    render(<Harness c={c} features={{ ...NO_SEND_FEATURES, accessCode: true, kba: true }} />);
    expect(screen.getAllByText('Add access code')).toHaveLength(2);
    expect(screen.getAllByText('Questions')).toHaveLength(2);
    expect(screen.queryByText('ID check')).toBeNull();
    expect(screen.queryByText('Witness')).toBeNull();
    expect(screen.queryByText('Require an SMS code')).toBeNull();
  });

  it('witness: the chip, then the signer it witnesses', async () => {
    const { c, dana, wes } = await twoSigners();
    render(<Harness c={c} features={ALL_ON} />);
    fireEvent.press(screen.getByTestId(`role-${wes.key}-WITNESS`));
    expect(screen.getByText(WITNESS_PICK_HINT)).toBeTruthy();
    // A witness takes no text delivery.
    expect(screen.queryByTestId(`sms-code-${wes.key}`)).toBeNull();
    fireEvent.press(screen.getByTestId(`witness-${wes.key}-${dana.key}`));
    expect(c.snapshot.draft!.payload.recipients[1]).toMatchObject({ kind: 'WITNESS', witnessForKey: dana.key });
    expect(screen.queryByText(WITNESS_PICK_HINT)).toBeNull();
  });

  it('delegation switch, access code, identity check and text delivery edit the draft', async () => {
    const { c, dana } = await twoSigners();
    render(<Harness c={c} features={ALL_ON} />);
    fireEvent(screen.getByTestId('allow-delegation'), 'valueChange', true);
    expect(c.snapshot.draft!.payload.allowDelegation).toBe(true);

    fireEvent.press(screen.getByTestId(`access-code-edit-${dana.key}`));
    fireEvent.changeText(screen.getByTestId(`access-code-input-${dana.key}`), '12');
    fireEvent.press(screen.getByTestId(`access-code-save-${dana.key}`));
    expect(screen.getAllByText(ACCESS_CODE_RULE).length).toBeGreaterThan(0);
    fireEvent.changeText(screen.getByTestId(`access-code-input-${dana.key}`), '4821');
    fireEvent.press(screen.getByTestId(`access-code-save-${dana.key}`));
    expect(screen.getByTestId(`access-code-state-${dana.key}`)).toHaveTextContent('Access code set');
    expect(c.snapshot.draft!.payload.recipients[0]!.accessCode).toBe('4821');
    fireEvent.press(screen.getByTestId(`access-code-remove-${dana.key}`));
    expect(screen.getByTestId(`access-code-state-${dana.key}`)).toHaveTextContent('No access code');

    fireEvent.press(screen.getByTestId(`identity-${dana.key}-ID_VERIFICATION`));
    expect(c.snapshot.draft!.payload.recipients[0]).toMatchObject({ identityCheck: 'ID_VERIFICATION', identityDirty: true });

    expect(screen.queryByTestId(`phone-${dana.key}`)).toBeNull();
    fireEvent.press(screen.getByTestId(`channel-${dana.key}-WHATSAPP`));
    await act(async () => undefined);
    fireEvent.changeText(screen.getByTestId(`phone-${dana.key}`), '0123');
    expect(screen.getByText('Use the international format, for example +14155550123')).toBeTruthy();
    fireEvent.changeText(screen.getByTestId(`phone-${dana.key}`), '+14155550123');
    fireEvent(screen.getByTestId(`sms-code-${dana.key}`), 'valueChange', true);
    expect(c.snapshot.draft!.payload.recipients[0]).toMatchObject({
      messaging: { channel: 'WHATSAPP', smsOtp: true, phone: '+14155550123' },
      messagingDirty: true,
    });
  });
});
