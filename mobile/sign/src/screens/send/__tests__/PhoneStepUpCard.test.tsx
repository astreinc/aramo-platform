// SIGN-FREE-PARITY-1 S2 — the sender's own phone step-up on Review and send (the web has the same panel).
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ApiError } from '../../../api/errors';
import type { WorkspaceClient } from '../../../api/workspaceClient';
import { PhoneStepUpCard } from '../PhoneStepUpCard';

const ON = { available: true, required: true, phone_masked: '+1••••••••67' };

function workspace(status: unknown, verify: () => Promise<unknown> = async () => ({ verified: true })) {
  const call = jest.fn(async (path: string) => {
    if (path.endsWith('/status')) return status;
    if (path.endsWith('/send')) return { sent: true, phone_masked: '+1••••••••67', expires_in_seconds: 600, resend_after_seconds: 60 };
    return verify();
  });
  return { ws: { call } as unknown as WorkspaceClient, call };
}

describe('PhoneStepUpCard', () => {
  it('self-serve off: renders nothing (Review keeps today’s message)', async () => {
    const { ws, call } = workspace({ available: false, required: true, phone_masked: null });
    render(<PhoneStepUpCard workspace={ws} onVerified={jest.fn()} />);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('phone-step-up')).toBeNull();
  });

  it('texts a code to the number on file, verifies it, then Send now', async () => {
    const { ws, call } = workspace(ON);
    const onVerified = jest.fn();
    render(<PhoneStepUpCard workspace={ws} onVerified={onVerified} />);
    await screen.findByText('We’ll text a code to +1••••••••67.');
    // SMS-OPTIN-1 — the 10DLC opt-in disclosure sits with the button.
    expect(screen.getByTestId('step-up-disclosure')).toHaveTextContent('We’ll text one 6-digit code to this number. Msg & data rates may apply. Reply STOP to opt out.');
    fireEvent.press(screen.getByTestId('step-up-send'));
    await screen.findByText('We texted a code to +1••••••••67. It expires in 10 minutes.');
    expect(call).toHaveBeenCalledWith('/v1/sign/personal/step-up/send', 'post', { body: {} });
    fireEvent.changeText(screen.getByTestId('step-up-code'), '12 34 56');
    fireEvent.press(screen.getByTestId('step-up-verify'));
    await screen.findByTestId('step-up-verified');
    expect(call).toHaveBeenCalledWith('/v1/sign/personal/step-up/verify', 'post', { body: { code: '123456' } });
    fireEvent.press(screen.getByTestId('step-up-send-now'));
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it('asks for a number when none is on file; a wrong code says so plainly', async () => {
    const { ws, call } = workspace({ ...ON, phone_masked: null }, async () => {
      throw new ApiError({ status: 400, code: 'VALIDATION_ERROR', reason: 'code_invalid' });
    });
    render(<PhoneStepUpCard workspace={ws} onVerified={jest.fn()} />);
    fireEvent.changeText(await screen.findByTestId('step-up-phone'), '+919876543210');
    fireEvent.press(screen.getByTestId('step-up-send'));
    await screen.findByTestId('step-up-code');
    expect(call).toHaveBeenCalledWith('/v1/sign/personal/step-up/send', 'post', { body: { phone: '+919876543210' } });
    fireEvent.changeText(screen.getByTestId('step-up-code'), '000000');
    fireEvent.press(screen.getByTestId('step-up-verify'));
    await screen.findByText('That code isn’t right. Check the code and try again.');
  });
});
