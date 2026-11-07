// M-A14 §1 item 7 / R-4 / R-5 — You've Signed: the paper card shows this account's own
// counts and is hidden while loading or when the stats call fails (no made-up numbers).
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { PAPER_INFO_BODY, YS_BODY, YouSignedScreen } from '../YouSignedScreen';
import { pathOf, renderWith, settle } from './helpers';

function renderSigned(stats: { status: number; body?: unknown }) {
  const props = { onViewSigned: jest.fn(), onViewCertificate: jest.fn(), onDone: jest.fn() };
  const r = renderWith(<YouSignedScreen envelopeId="env-1" {...props} />, (req) =>
    pathOf(req.url) === '/v1/sign/me/signing-stats' ? stats : { status: 404, body: {} },
  );
  return { ...r, props };
}

describe('YouSignedScreen', () => {
  it('renders the a16 copy and the R-5 actions above Done', () => {
    const { props } = renderSigned({ status: 200, body: { documents_signed: 1, pages_signed: 3 } });
    expect(screen.getByText("You've Signed")).toBeTruthy();
    expect(screen.getByText(YS_BODY)).toBeTruthy();
    fireEvent.press(screen.getByText('View signed copy'));
    fireEvent.press(screen.getByText('View certificate'));
    fireEvent.press(screen.getByText('Done'));
    expect(props.onViewSigned).toHaveBeenCalledTimes(1);
    expect(props.onViewCertificate).toHaveBeenCalledTimes(1);
    expect(props.onDone).toHaveBeenCalledTimes(1);
  });

  it('shows the paper card with singular / plural counts', async () => {
    const { net } = renderSigned({ status: 200, body: { documents_signed: 1, pages_signed: 3 } });
    // hidden while loading
    expect(screen.queryByTestId('paper-card')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('paper-card')).toBeTruthy());
    expect(screen.getByText('You’re helping save paper')).toBeTruthy();
    expect(screen.getByText('1 document')).toBeTruthy();
    expect(screen.getByText('signed with Aramo Sign')).toBeTruthy();
    expect(screen.getByText('3 sheets')).toBeTruthy();
    expect(screen.getByText('of paper you didn’t print')).toBeTruthy();
    expect(net.calls.filter((c) => pathOf(c.url) === '/v1/sign/me/signing-stats')).toHaveLength(1);
  });

  it('pluralises many documents and a single sheet', async () => {
    renderSigned({ status: 200, body: { documents_signed: 4, pages_signed: 1 } });
    await waitFor(() => expect(screen.getByText('4 documents')).toBeTruthy());
    expect(screen.getByText('1 sheet')).toBeTruthy();
  });

  it('hides the card when the stats call fails', async () => {
    const { net } = renderSigned({ status: 500, body: { reason: 'internal', code: 'internal' } });
    await waitFor(() =>
      expect(net.calls.some((c) => pathOf(c.url) === '/v1/sign/me/signing-stats')).toBe(true),
    );
    await settle(20);
    expect(screen.queryByTestId('paper-card')).toBeNull();
    expect(screen.queryByText(/document/)).toBeNull();
    expect(screen.getByText('Done')).toBeTruthy();
  });

  it('hides the card when the response is malformed', async () => {
    const { net } = renderSigned({ status: 200, body: { documents_signed: 'many' } });
    await waitFor(() => expect(net.calls.length).toBeGreaterThan(0));
    await settle(20);
    expect(screen.queryByTestId('paper-card')).toBeNull();
  });

  it('ⓘ opens the explanation that the counts are only your own documents', async () => {
    renderSigned({ status: 200, body: { documents_signed: 2, pages_signed: 5 } });
    await waitFor(() => expect(screen.getByLabelText('About these numbers')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('About these numbers'));
    await waitFor(() => expect(screen.getByText(PAPER_INFO_BODY)).toBeTruthy());
  });
});
