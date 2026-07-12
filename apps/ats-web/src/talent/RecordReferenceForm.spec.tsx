import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecordReferenceForm } from './RecordReferenceForm';
import * as api from './talent-api';

// TR-9 B1 (D5) — the capture affordance: renders, has NO rating/rating input
// (R10 structural), and posts the reference on submit.

describe('RecordReferenceForm', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the capture fields and has NO quality-number input at all', () => {
    render(<RecordReferenceForm recordId="tal-1" />);
    expect(screen.getByLabelText(/Referee name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Relationship/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/What the referee said/i)).toBeInTheDocument();
    // STRUCTURAL R10: no rating/quality-number affordance exists.
    expect(screen.queryByLabelText(/rating/i)).toBeNull();
    expect(screen.queryByLabelText(/quality/i)).toBeNull();
  });

  it('posts the reference on submit and confirms', async () => {
    const spy = vi
      .spyOn(api, 'recordReferenceAttestation')
      .mockResolvedValue({ recorded: true, evidence_id: 'ev-1' });
    render(<RecordReferenceForm recordId="tal-1" />);
    fireEvent.change(screen.getByLabelText(/Referee name/i), { target: { value: 'Charles Babbage' } });
    fireEvent.change(screen.getByLabelText(/Relationship/i), { target: { value: 'former manager' } });
    fireEvent.change(screen.getByLabelText(/What the referee said/i), {
      target: { value: 'Led the engine team ably.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Record reference/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledOnce());
    const [recordId, body] = spy.mock.calls[0]!;
    expect(recordId).toBe('tal-1');
    expect(body.attester.name).toBe('Charles Babbage');
    expect(body.statement_class).toBe('WORK');
    // No quality-number ever reaches the wire.
    expect(JSON.stringify(body)).not.toContain('rating');
    await screen.findByText(/Reference recorded/i);
  });
});
