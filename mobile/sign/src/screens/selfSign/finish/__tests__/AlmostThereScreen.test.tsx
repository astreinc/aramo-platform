// M-A14 §1 item 6 / R-2 / R-5 — Email · Share · Save on the executed PDF; Email falls back
// to the share sheet when the device has no mail account.
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { AlmostThereScreen } from '../AlmostThereScreen';
import { pathOf, renderWith } from './helpers';

const mockMailAvailable = jest.fn();
const mockCompose = jest.fn();
jest.mock('expo-mail-composer', () => ({
  isAvailableAsync: () => mockMailAvailable(),
  composeAsync: (o: unknown) => mockCompose(o),
}));
const mockOpen = jest.fn(async () => undefined);
const mockWrite = jest.fn(async (name: string) => `file:///cache/share/${name}`);
jest.mock('../../../../features/share/shareNative', () => ({
  nativeShareFiles: { writeTemp: (n: string) => mockWrite(n), remove: () => undefined },
  nativeShareSheet: { available: async () => true, open: (...a: unknown[]) => mockOpen(...(a as [])) },
  nativeSaveFolder: { pick: async () => null },
}));

const responder = (req: { url: string }) =>
  pathOf(req.url) === '/v1/sign/sender/envelopes/env-1/executed'
    ? { status: 200, body: { documents: [{ title: 'Lease Agreement', executed_base64: 'JVBERi0=' }] } }
    : { status: 404, body: {} };

function renderAlmost(onFinish = jest.fn()) {
  renderWith(
    <AlmostThereScreen envelopeId="env-1" documentTitle="Lease Agreement" onFinishSigning={onFinish} />,
    responder,
  );
  return onFinish;
}

describe('AlmostThereScreen', () => {
  it('renders the a13 copy, the three labelled actions and Finish Signing', () => {
    const onFinish = renderAlmost();
    expect(screen.getByText("You're almost there")).toBeTruthy();
    expect(screen.getByText('Now, send a copy to others')).toBeTruthy();
    expect(screen.getByLabelText('Email a copy')).toBeTruthy();
    expect(screen.getByLabelText('Share a copy')).toBeTruthy();
    expect(screen.getByLabelText('Save a copy')).toBeTruthy();
    fireEvent.press(screen.getByText('Finish Signing'));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('Email with no mail account opens the share sheet instead', async () => {
    mockMailAvailable.mockResolvedValue(false);
    renderAlmost();
    fireEvent.press(screen.getByLabelText('Email a copy'));
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));
    expect(mockCompose).not.toHaveBeenCalled();
    expect(mockOpen).toHaveBeenCalledWith('file:///cache/share/Lease Agreement.pdf', {
      mimeType: 'application/pdf',
      dialogTitle: 'Lease Agreement',
    });
    await waitFor(() => expect(screen.getByText('✓ Shared 1 time')).toBeTruthy());
  });

  it('Email with a mail account opens the composer with subject and attachment', async () => {
    mockMailAvailable.mockResolvedValue(true);
    mockCompose.mockResolvedValue({ status: 'sent' });
    renderAlmost();
    fireEvent.press(screen.getByLabelText('Email a copy'));
    await waitFor(() =>
      expect(mockCompose).toHaveBeenCalledWith({
        subject: 'Lease Agreement',
        attachments: ['file:///cache/share/Lease Agreement.pdf'],
      }),
    );
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it('Share opens the share sheet with the executed PDF', async () => {
    renderAlmost();
    fireEvent.press(screen.getByLabelText('Share a copy'));
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('✓ Shared 1 time')).toBeTruthy());
  });
});
