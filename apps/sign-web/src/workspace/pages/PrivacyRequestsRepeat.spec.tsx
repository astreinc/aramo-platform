import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PrivacyRequestView } from '../api';
import { ALREADY_OPEN_COPY, PrivacyRequestsSection } from './PrivacyRequests';

// UAT DEL-06 — one open request per type: a repeat answers the open one, and the page says so.
const OPEN: PrivacyRequestView = {
  reference: 'PR-RDVV-CEC8-WJGJ',
  request_type: 'ACCESS',
  subject_kind: 'BUSINESS_MEMBER',
  channel: 'IN_APP',
  status: 'DATA_INVENTORY',
  status_label: 'Being reviewed by the Aramo privacy team',
  referred_to_organization: false,
  due_at: '2026-12-18T00:00:00Z',
  created_at: '2026-11-18T00:00:00Z',
  updated_at: '2026-11-18T00:00:00Z',
  completed_at: null,
  outcome_code: null,
  outcome_text: null,
  retained: [],
  organization_decides: null,
  privacy_contact: 'privacy@aramo.ai',
};

describe('Privacy requests — repeat of an open request (DEL-06)', () => {
  it('says the request is already open and shows its ID', async () => {
    render(<PrivacyRequestsSection personal={false} loader={async () => ({ items: [OPEN] })} requester={vi.fn(async () => OPEN)} />);
    await waitFor(() => expect(screen.getByTestId('settings-privacy-open')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('settings-privacy-type-ACCESS'));
    fireEvent.click(screen.getByTestId('settings-privacy-send'));
    expect(await screen.findByTestId('settings-privacy-already-open')).toHaveTextContent(ALREADY_OPEN_COPY);
    expect(screen.getByTestId('settings-privacy-result')).toHaveTextContent('PR-RDVV-CEC8-WJGJ');
  });

  it('a new request has no already-open note', async () => {
    const fresh = { ...OPEN, reference: 'PR-NEW0-0000-0001', request_type: 'EXPORT' as const };
    render(<PrivacyRequestsSection personal={false} loader={async () => ({ items: [OPEN] })} requester={vi.fn(async () => fresh)} />);
    await waitFor(() => expect(screen.getByTestId('settings-privacy-open')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('settings-privacy-type-EXPORT'));
    fireEvent.click(screen.getByTestId('settings-privacy-send'));
    expect(await screen.findByTestId('settings-privacy-result')).toHaveTextContent('PR-NEW0-0000-0001');
    expect(screen.queryByTestId('settings-privacy-already-open')).toBeNull();
  });
});
