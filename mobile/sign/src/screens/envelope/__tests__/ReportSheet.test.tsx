// UAT SIG-14 retest (web ≡ app): the app's "Report this envelope" has the web report page's
// optional reason, optional 500-character note, "Send report" and confirmation with the
// Acceptable Use Policy link.
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { REPORT_NOTE_MAX, REPORT_THANKS, ReportSheet, type ReportSendResult } from '../ReportSheet';

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })) }));
// The first render of a sheet in a fresh worker is slow under jest-expo.
jest.setTimeout(30_000);

function open(onSend: (r: string | null, n: string) => Promise<ReportSendResult>) {
  const onClose = jest.fn();
  render(<ReportSheet visible busy={false} onSend={onSend} onClose={onClose} />);
  return { onClose };
}

describe('ReportSheet', () => {
  it('sends the chosen reason and the trimmed note, then shows the web confirmation', async () => {
    const onSend = jest.fn(async () => ({ kind: 'sent' }) as const);
    open(onSend);
    fireEvent.press(screen.getByTestId('report-reason-phishing'));
    fireEvent.changeText(screen.getByTestId('report-note'), '  Asked for my bank login  ');
    fireEvent.press(screen.getByTestId('report-send'));
    await waitFor(() => expect(screen.getByTestId('report-thanks')).toBeTruthy());
    expect(onSend).toHaveBeenCalledWith('phishing', 'Asked for my bank login');
    expect(screen.getByText(REPORT_THANKS.title)).toBeTruthy();
    expect(screen.getByTestId('report-thanks').props.children).toBe(REPORT_THANKS.sent + REPORT_THANKS.rest);
    expect(screen.getByText('Acceptable Use Policy')).toBeTruthy();
  });

  it('reason and note are optional, as on the web', async () => {
    const onSend = jest.fn(async () => ({ kind: 'already' }) as const);
    open(onSend);
    fireEvent.press(screen.getByTestId('report-send'));
    await waitFor(() => expect(screen.getByTestId('report-thanks')).toBeTruthy());
    expect(onSend).toHaveBeenCalledWith(null, '');
    expect(screen.getByTestId('report-thanks').props.children).toBe(REPORT_THANKS.already + REPORT_THANKS.rest);
  });

  it('a second tap clears the reason', async () => {
    const onSend = jest.fn(async () => ({ kind: 'sent' }) as const);
    open(onSend);
    fireEvent.press(screen.getByTestId('report-reason-spam'));
    fireEvent.press(screen.getByTestId('report-reason-spam'));
    fireEvent.press(screen.getByTestId('report-send'));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(null, ''));
  });

  it('keeps the form and shows the refusal when sending fails', async () => {
    open(async () => ({ kind: 'error', message: 'Too many reports from this connection. Try again later.' }));
    fireEvent.press(screen.getByTestId('report-send'));
    await waitFor(() => expect(screen.getByText('Too many reports from this connection. Try again later.')).toBeTruthy());
    expect(screen.queryByTestId('report-thanks')).toBeNull();
    expect(screen.getByTestId('report-send')).toBeTruthy();
  });

  it('limits the note to 500 characters, as the web, with a counter', () => {
    open(async () => ({ kind: 'sent' }));
    expect(REPORT_NOTE_MAX).toBe(500);
    expect(screen.getByTestId('report-note').props.maxLength).toBe(500);
    fireEvent.changeText(screen.getByTestId('report-note'), 'abc');
    expect(screen.getByTestId('report-note-count').props.children).toBe('3 / 500');
  });
});
