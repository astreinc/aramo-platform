// APP-DELETED-1 A2 (UAT DEL-10) — the app's purge banner and sheet.
import { fireEvent, render, screen } from '@testing-library/react-native';

import { PurgeBanner, PurgeSheet } from '../PurgeControls';

jest.setTimeout(30_000);

const queued = { state: 'QUEUED', level: 'DOCUMENTS', due_at: '2026-12-11T05:00:00Z', executed_at: null } as const;

describe('PurgeBanner', () => {
  it('shows the schedule and Cancel purge when the server allows it', () => {
    const onCancel = jest.fn();
    render(<PurgeBanner purge={queued} canCancel busy={false} online onCancel={onCancel} />);
    expect(screen.getByTestId('purge-banner')).toHaveTextContent(/Purge scheduled: documents will be deleted permanently on/);
    fireEvent.press(screen.getByTestId('cancel-purge'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('no Cancel purge without actions.dequeue_purge; nothing for a cancelled or absent purge', () => {
    const { rerender } = render(<PurgeBanner purge={queued} canCancel={false} busy={false} online onCancel={jest.fn()} />);
    expect(screen.queryByTestId('cancel-purge')).toBeNull();
    rerender(<PurgeBanner purge={{ ...queued, state: 'DEQUEUED' }} canCancel busy={false} online onCancel={jest.fn()} />);
    expect(screen.queryByTestId('purge-banner')).toBeNull();
    rerender(<PurgeBanner purge={null} canCancel busy={false} online onCancel={jest.fn()} />);
    expect(screen.queryByTestId('purge-banner')).toBeNull();
  });

  it('after the purge: says it was purged, no Cancel', () => {
    render(<PurgeBanner purge={{ ...queued, state: 'EXECUTED', executed_at: '2026-12-11T05:00:00Z' }} canCancel busy={false} online onCancel={jest.fn()} />);
    expect(screen.getByTestId('purge-banner')).toHaveTextContent(/were purged on/);
    expect(screen.queryByTestId('cancel-purge')).toBeNull();
  });
});

describe('PurgeSheet', () => {
  it('queues only after typing PURGE, with the chosen level', () => {
    const onQueue = jest.fn();
    render(<PurgeSheet visible busy={false} error={null} online onQueue={onQueue} onClose={jest.fn()} />);
    expect(screen.getByText('Purge this envelope?')).toBeTruthy();
    fireEvent.press(screen.getByTestId('purge-level-DOCUMENTS_AND_METADATA'));
    fireEvent.changeText(screen.getByTestId('purge-confirm-input'), 'purge');
    fireEvent.press(screen.getByTestId('confirm-purge'));
    expect(onQueue).not.toHaveBeenCalled();
    fireEvent.changeText(screen.getByTestId('purge-confirm-input'), 'PURGE');
    fireEvent.press(screen.getByTestId('confirm-purge'));
    expect(onQueue).toHaveBeenCalledWith('DOCUMENTS_AND_METADATA');
  });

  it('shows a refusal', () => {
    render(<PurgeSheet visible busy={false} error="Only a completed, declined or voided envelope can be purged." online onQueue={jest.fn()} onClose={jest.fn()} />);
    expect(screen.getByText(/Only a completed/)).toBeTruthy();
  });
});
