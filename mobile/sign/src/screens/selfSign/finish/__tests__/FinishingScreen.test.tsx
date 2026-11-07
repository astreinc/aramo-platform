// M-A14 §1 item 5 / R-1 — Finishing… waits on the real call; a failure offers Try again.
import { fireEvent, render, screen } from '@testing-library/react-native';

import { FINISH_FAILED_FALLBACK, FinishingScreen } from '../FinishingScreen';

describe('FinishingScreen', () => {
  it('shows the spinner card and "Finishing…" while working, with no retry', () => {
    render(<FinishingScreen state="working" onRetry={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByText('Finishing…')).toBeTruthy();
    expect(screen.getByLabelText('Finishing')).toBeTruthy();
    expect(screen.queryByTestId('finishing-retry')).toBeNull();
  });

  it('failed: shows the message, and Try again calls onRetry', () => {
    const onRetry = jest.fn();
    const onCancel = jest.fn();
    render(
      <FinishingScreen state="failed" message="Couldn’t reach Aramo Sign." onRetry={onRetry} onCancel={onCancel} />,
    );
    expect(screen.getByText('Couldn’t reach Aramo Sign.')).toBeTruthy();
    expect(screen.queryByText('Finishing…')).toBeNull();
    fireEvent.press(screen.getByText('Try again'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('failed without a message uses the fallback copy', () => {
    render(<FinishingScreen state="failed" onRetry={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByText(FINISH_FAILED_FALLBACK)).toBeTruthy();
  });
});
