import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { UpcomingLegalNotice } from '../api';

import { LegalChangeNotice, noticeDate } from './LegalChangeNotice';

// Privacy Notice 1.1 remediation E-6 — the in-service notice of an upcoming legal version.

const PRIVACY: UpcomingLegalNotice = {
  key: 'aramo.privacy_notice',
  title: 'Aramo Privacy Notice',
  version: '1.1',
  effective_date: '2026-11-25',
  url: 'https://sign.aramo.ai/legal/privacy/1.1',
  current_version: '1.0',
  current_url: 'https://sign.aramo.ai/legal/privacy/1.0',
};
const TERMS: UpcomingLegalNotice = {
  ...PRIVACY,
  key: 'sign.personal_terms_of_service',
  title: 'Aramo Sign Personal Terms of Service',
  url: 'https://sign.aramo.ai/legal/personal-terms/1.1',
  current_url: 'https://sign.aramo.ai/legal/personal-terms/1.0',
};

describe('LegalChangeNotice', () => {
  it('renders nothing (and records nothing) when there is no upcoming change', async () => {
    const load = vi.fn(async () => ({ notices: [] }));
    const record = vi.fn(async () => ({ notices: [] }));
    const { container } = render(<LegalChangeNotice load={load} record={record} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
    expect(record).not.toHaveBeenCalled();
  });

  it('shows each upcoming change with its date and both links, and records SHOWN once per notice', async () => {
    const load = vi.fn(async () => ({ notices: [PRIVACY, TERMS] }));
    const record = vi.fn(async () => ({ notices: [PRIVACY, TERMS] }));
    const { rerender } = render(<LegalChangeNotice load={load} record={record} />);
    const items = await screen.findAllByTestId('legal-change-notice');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('We are updating the Aramo Privacy Notice. Version 1.1 takes effect on 25 November 2026. Until then, version 1.0 applies.');
    expect(screen.getAllByRole('link', { name: 'Read the new version' })[0]).toHaveAttribute('href', PRIVACY.url);
    expect(screen.getAllByRole('link', { name: 'Current version' })[0]).toHaveAttribute('href', PRIVACY.current_url);
    await waitFor(() => expect(record).toHaveBeenCalledTimes(2));
    expect(record).toHaveBeenCalledWith(PRIVACY, 'SHOWN');
    expect(record).toHaveBeenCalledWith(TERMS, 'SHOWN');
    rerender(<LegalChangeNotice load={load} record={record} />);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('Dismiss hides that notice and records ACKNOWLEDGED', async () => {
    const load = vi.fn(async () => ({ notices: [PRIVACY, TERMS] }));
    const record = vi.fn(async () => ({ notices: [] }));
    render(<LegalChangeNotice load={load} record={record} />);
    const buttons = await screen.findAllByTestId('legal-change-notice-dismiss');
    await act(async () => {
      fireEvent.click(buttons[0]!);
    });
    expect(record).toHaveBeenCalledWith(PRIVACY, 'ACKNOWLEDGED');
    expect(screen.getAllByTestId('legal-change-notice')).toHaveLength(1);
    expect(screen.getByTestId('legal-change-notice')).toHaveTextContent('Aramo Sign Personal Terms of Service');
  });

  it('a failed read or record never breaks the page', async () => {
    const load = vi.fn(async () => {
      throw new Error('offline');
    });
    const { container } = render(<LegalChangeNotice load={load} />);
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();

    const record = vi.fn(async () => {
      throw new Error('offline');
    });
    render(<LegalChangeNotice load={async () => ({ notices: [PRIVACY] })} record={record} />);
    const dismiss = await screen.findByTestId('legal-change-notice-dismiss');
    await act(async () => {
      fireEvent.click(dismiss);
    });
    expect(screen.queryByTestId('legal-change-notice')).toBeNull();
  });

  it('formats calendar dates without a time-zone shift', () => {
    expect(noticeDate('2026-11-25')).toBe('25 November 2026');
    expect(noticeDate('2027-01-01')).toBe('1 January 2027');
    expect(noticeDate('soon')).toBe('soon');
  });
});
