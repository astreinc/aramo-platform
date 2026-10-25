// Adopt-signature PNG path (directive §6, §7 C-19; M-A3 §4): Type and Draw are both
// rasterized to PNG; the default is saved through /v1/sign/me/signature | /me/initials.
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { workspaceWith } from '../../inbox/__tests__/fixtures';
import { MAX_IMAGE_BYTES, pngDataUrl, saveDefaultMark, SCRIPT_FONT_KEY } from '../adopt';
import { AdoptSignatureSheet } from '../AdoptSignatureSheet';

jest.mock('react-native-view-shot', () => ({ captureRef: jest.fn() }));
// The first render of a sheet in a fresh worker is slow under jest-expo.
jest.setTimeout(30_000);

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('pngDataUrl', () => {
  it('wraps a base64 PNG capture as a PNG data URL', () => {
    expect(pngDataUrl(PNG_B64)).toBe(`data:image/png;base64,${PNG_B64}`);
    expect(pngDataUrl(`data:image/png;base64,${PNG_B64}`)).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it('refuses anything that is not a PNG (no SVG / vector strokes, C-19)', () => {
    expect(() => pngDataUrl('PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=')).toThrow(
      'not a PNG',
    );
    expect(() => pngDataUrl('/9j/4AAQSkZJRgABAQ')).toThrow('not a PNG');
  });

  it('refuses an image over the server limit', () => {
    expect(() =>
      pngDataUrl('iVBORw0KGgo' + 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8)),
    ).toThrow('too large');
  });
});

describe('AdoptSignatureSheet', () => {
  it('Type: rasterizes the typed name to PNG and offers saving the default', async () => {
    const capture = jest.fn(async () => pngDataUrl(PNG_B64));
    const onAdopt = jest.fn();
    render(
      <AdoptSignatureSheet
        visible
        target="SIGNATURE"
        mode="sign"
        defaultName=""
        canSaveDefault
        onAdopt={onAdopt}
        onClose={jest.fn()}
        capture={capture}
      />,
    );
    expect(screen.getByText('Adopt your signature')).toBeTruthy();
    // Disabled while the name is empty.
    fireEvent.press(screen.getByTestId('adopt-confirm'));
    expect(capture).not.toHaveBeenCalled();
    fireEvent.changeText(screen.getByTestId('adopt-name'), 'Jo Signer');
    fireEvent.press(screen.getByTestId('adopt-confirm'));
    await waitFor(() => expect(onAdopt).toHaveBeenCalled());
    expect(onAdopt).toHaveBeenCalledWith({
      mark: { dataUrl: `data:image/png;base64,${PNG_B64}`, method: 'TYPED' },
      typedName: 'Jo Signer',
      saveDefault: true,
    });
    expect(
      screen.getByText(
        'By tapping Adopt and sign, I agree this is my electronic signature and initials.',
      ),
    ).toBeTruthy();
  });

  it('Draw: disabled until something is drawn; initials read "Adopt and initial"', () => {
    render(
      <AdoptSignatureSheet
        visible
        target="INITIALS"
        mode="sign"
        defaultName="Jo Signer"
        canSaveDefault={false}
        onAdopt={jest.fn()}
        onClose={jest.fn()}
        capture={jest.fn()}
      />,
    );
    expect(screen.getByText('Adopt your initials')).toBeTruthy();
    fireEvent.press(screen.getByTestId('adopt-tab-draw'));
    expect(screen.getByText('Sign here with your finger')).toBeTruthy();
    expect(screen.getByTestId('adopt-confirm').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    // Signed out: no "save as default" offer.
    expect(screen.queryByText(/Save as my default/)).toBeNull();
  });

  it('Account mode reads "Save signature" and always saves', async () => {
    const onAdopt = jest.fn();
    render(
      <AdoptSignatureSheet
        visible
        target="SIGNATURE"
        mode="account"
        defaultName="Jo"
        canSaveDefault
        onAdopt={onAdopt}
        onClose={jest.fn()}
        capture={async () => pngDataUrl(PNG_B64)}
      />,
    );
    fireEvent.press(screen.getByText('Save signature'));
    await waitFor(() =>
      expect(onAdopt).toHaveBeenCalledWith(expect.objectContaining({ saveDefault: true })),
    );
  });
});

describe('saveDefaultMark', () => {
  it('PUTs a TYPED default with name, font key and the PNG', async () => {
    const { net, workspace } = workspaceWith(() => ({ status: 200, body: {} }));
    await saveDefaultMark(
      workspace,
      'SIGNATURE',
      { dataUrl: `data:image/png;base64,${PNG_B64}`, method: 'TYPED' },
      'Jo Signer',
    );
    expect(net.calls[0]!.method).toBe('PUT');
    expect(net.calls[0]!.url).toMatch(/\/v1\/sign\/me\/signature$/);
    expect(net.calls[0]!.body).toEqual({
      kind: 'TYPED',
      typed_name: 'Jo Signer',
      font_key: SCRIPT_FONT_KEY,
      image_data_url: `data:image/png;base64,${PNG_B64}`,
    });
    expect(SCRIPT_FONT_KEY).toMatch(/^[a-z0-9][a-z0-9_-]{0,39}$/);
  });

  it('PUTs DRAWN initials to /me/initials', async () => {
    const { net, workspace } = workspaceWith(() => ({ status: 200, body: {} }));
    await saveDefaultMark(workspace, 'INITIALS', {
      dataUrl: `data:image/png;base64,${PNG_B64}`,
      method: 'DRAWN',
    });
    expect(net.calls[0]!.url).toMatch(/\/v1\/sign\/me\/initials$/);
    expect(net.calls[0]!.body).toEqual({
      kind: 'DRAWN',
      image_data_url: `data:image/png;base64,${PNG_B64}`,
    });
  });
});
