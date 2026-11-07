// M-A14 §1 item 8 — Done on You've Signed asks the shell to offer "Want to sign another
// document?"; Sign Next opens that inbox item in the existing received-signing flow.
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { dismissSignNext, requestSignNext, signNextRequested } from '../selfSignHandoff';
import { SignNextHost } from '../SignNextHost';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({ navigate: mockNavigate }),
}));
jest.mock('../../../screens/selfSign/finish', () => {
  const { Pressable, View } = jest.requireActual('react-native');
  return {
    SignNextModal: (p: { visible: boolean; onClose: () => void; onSignNext: (item: { id: string }) => void }) =>
      p.visible ? (
        <View testID="sign-next-modal">
          <Pressable testID="sign-next-no" onPress={p.onClose} />
          <Pressable testID="sign-next-go" onPress={() => p.onSignNext({ id: 'inbox-7' })} />
        </View>
      ) : null,
  };
});

beforeEach(() => dismissSignNext());

describe('SignNextHost', () => {
  it('stays closed until Done asks for it; No thanks closes it', () => {
    render(<SignNextHost />);
    expect(screen.queryByTestId('sign-next-modal')).toBeNull();
    act(() => requestSignNext());
    expect(screen.getByTestId('sign-next-modal')).toBeTruthy();
    fireEvent.press(screen.getByTestId('sign-next-no'));
    expect(screen.queryByTestId('sign-next-modal')).toBeNull();
    expect(signNextRequested()).toBe(false);
  });

  it('Sign Next opens the inbox item in the received-signing flow', () => {
    requestSignNext();
    render(<SignNextHost />);
    fireEvent.press(screen.getByTestId('sign-next-go'));
    expect(mockNavigate).toHaveBeenCalledWith('Signing', { envelopeId: 'inbox-7' });
    expect(screen.queryByTestId('sign-next-modal')).toBeNull();
  });
});
