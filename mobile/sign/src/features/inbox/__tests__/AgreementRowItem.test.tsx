// Every swipe action is also a VoiceOver / TalkBack custom action (M-A4 §3.6), and the
// received view offers Share only for a completed, downloadable envelope (§3.7).
import { fireEvent, render, screen } from '@testing-library/react-native';

import { ReceivedEnvelopeView } from '../../../screens/envelope/ReceivedEnvelopeScreen';
import { AgreementRowItem } from '../AgreementRowItem';
import { mergeAgreements } from '../agreementsModel';
import { swipeActionsFor } from '../rowActionRules';
import type { SenderContext } from '../types';
import { CTX_OWNER, received, sent } from './fixtures';

describe('AgreementRowItem accessibility actions', () => {
  it('exposes the row actions as custom actions and runs the chosen one', () => {
    const row = mergeAgreements([sent('IN_PROGRESS', { subject: 'MSA' })], null)[0]!;
    const actions = swipeActionsFor(row, {
      sender: CTX_OWNER as unknown as SenderContext,
      online: true,
    });
    const onAction = jest.fn();
    render(
      <AgreementRowItem row={row} onPress={jest.fn()} actions={actions} onAction={onAction} />,
    );
    const el = screen.getByRole('button');
    expect(el.props.accessibilityActions).toEqual([
      { name: 'remind', label: 'Remind MSA' },
      { name: 'void', label: 'Void MSA' },
    ]);
    fireEvent(el, 'accessibilityAction', { nativeEvent: { actionName: 'void' } });
    expect(onAction).toHaveBeenCalledWith(row, 'void');
    expect(screen.getByText(/Waiting for others · 1 of 2 signed/)).toBeTruthy();
  });

  it('no custom actions when the row has none', () => {
    const row = mergeAgreements([sent('VOIDED')], null)[0]!;
    render(<AgreementRowItem row={row} onPress={jest.fn()} actions={[]} onAction={jest.fn()} />);
    expect(screen.getByRole('button').props.accessibilityActions).toBeUndefined();
  });
});

describe('ReceivedEnvelopeView Share', () => {
  const base = { online: true, onSign: jest.fn(), onSignedCopy: jest.fn(), onRemove: jest.fn() };

  it('shown for COMPLETED + can_download', () => {
    const onShare = jest.fn();
    render(
      <ReceivedEnvelopeView
        {...base}
        item={received({ envelope_status: 'COMPLETED', can_download: true, can_sign: false })}
        onShare={onShare}
      />,
    );
    fireEvent.press(screen.getByTestId('received-share'));
    expect(onShare).toHaveBeenCalled();
  });

  it('hidden for an envelope that is not completed', () => {
    render(
      <ReceivedEnvelopeView
        {...base}
        item={received({ envelope_status: 'DECLINED', can_download: true, can_sign: false })}
        onShare={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('received-share')).toBeNull();
  });
});
