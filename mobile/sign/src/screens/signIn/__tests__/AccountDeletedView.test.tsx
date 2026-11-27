// APP-DELETED-1 A1 — after a deletion that signed the user out, the signed-out screen shows the
// receipt (request ID, status, what is kept) before the sign-in buttons.
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';

import { clearDeletionReceipt, deletionReceipt, setDeletionReceipt, useDeletionReceipt } from '../../../features/account/deletionReceiptStore';
import type { PrivacyRequest } from '../../../features/account/privacy';
import { AccountDeletedView } from '../SignInScreen';

jest.setTimeout(30_000);

const REQUEST = {
  reference: 'PR-7K3M-9QX2-H4TD',
  status: 'COMPLETED',
  status_label: 'Completed',
  outcome_text: 'Your account was deleted.',
  organization_decides: null,
  retained: [{ key: 'signing_evidence', label: 'Signed agreements and their evidence', why: 'Kept under the retention rules.' }],
} as unknown as PrivacyRequest;

afterEach(() => clearDeletionReceipt());

describe('deletion receipt', () => {
  it('is held in memory and observed until cleared', () => {
    const { result } = renderHook(() => useDeletionReceipt());
    expect(result.current).toBeNull();
    act(() => setDeletionReceipt(REQUEST));
    expect(result.current?.reference).toBe('PR-7K3M-9QX2-H4TD');
    act(() => clearDeletionReceipt());
    expect(result.current).toBeNull();
    expect(deletionReceipt()).toBeNull();
  });

  it('the signed-out screen shows the request ID, status and what is kept; Done dismisses it', () => {
    const onDone = jest.fn();
    render(<AccountDeletedView request={REQUEST} onDone={onDone} />);
    expect(screen.getByText('Your account was deleted')).toBeTruthy();
    expect(screen.getByTestId('delete-account-reference')).toHaveTextContent('PR-7K3M-9QX2-H4TD');
    expect(screen.getByTestId('delete-account-status')).toHaveTextContent('Status: Completed');
    expect(screen.getByText(/Signed agreements and their evidence/)).toBeTruthy();
    expect(screen.queryByText('Your session ended. Sign in again.')).toBeNull();
    fireEvent.press(screen.getByTestId('delete-account-done'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
