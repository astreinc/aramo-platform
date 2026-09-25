import { ToastProvider } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createNote } from './activity-api';
import { LogNoteDialog } from './LogNoteDialog';

// G2.6 — the Requisition Detail "Log a note" modal. Category + Visibility mirror
// the ratified RN-1 enums exactly (7 categories; TEAM + PRIVATE only —
// RESTRICTED is DEFERRED and must not render).

vi.mock('./activity-api', () => ({
  createNote: vi.fn().mockResolvedValue({ id: 'a1' }),
}));

const createNoteMock = vi.mocked(createNote);

function open() {
  render(
    <ToastProvider>
      <LogNoteDialog
        requisitionId="req-1"
        requisitionCode="REQ-1000"
        requisitionTitle="Business Analyst"
      />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Log note' }));
}

describe('LogNoteDialog (G2.6)', () => {
  it('renders all 7 RN-1 category pills with GENERAL preselected', () => {
    open();
    for (const label of [
      'General',
      'Client interaction',
      'Hiring team',
      'Commercial',
      'Interview feedback',
      'Decision',
      'Risk / blocker',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(
      screen.getByRole('button', { name: 'General' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('Visibility offers exactly Requisition team + Private to me (no RESTRICTED)', () => {
    open();
    expect(screen.getByRole('option', { name: 'Requisition team' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Private to me' })).toBeInTheDocument();
    expect(screen.queryByText(/RESTRICTED/i)).toBeNull();
    expect(screen.queryByRole('option', { name: /restricted/i })).toBeNull();
  });

  it('the description line and header clause change with the visibility selection', () => {
    open();
    // Default TEAM.
    expect(
      screen.getByText('Everyone on the requisition team can see this note.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/visible to the requisition team/i),
    ).toBeInTheDocument();
    // Switch to PRIVATE.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'PRIVATE' } });
    expect(screen.getByText('Only you can see this note.')).toBeInTheDocument();
    expect(screen.getByText(/private to you/i)).toBeInTheDocument();
  });

  it('shows the RN-1 hint copy (plain text · char limit) and no Markdown label', () => {
    open();
    expect(
      screen.getByText(/saved notes can be redacted, not edited/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Plain text · links auto-detected · 20,000 char limit/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/markdown/i)).toBeNull();
  });

  it('saves the selected category + visibility + pin through createNote', async () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Decision' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'PRIVATE' } });
    fireEvent.change(screen.getByPlaceholderText(/Capture decisions/i), {
      target: { value: 'A decision was made.' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /pin to overview/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));

    await waitFor(() => expect(createNoteMock).toHaveBeenCalledTimes(1));
    expect(createNoteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subject_type: 'requisition',
        subject_id: 'req-1',
        notes: 'A decision was made.',
        category: 'DECISION',
        visibility: 'PRIVATE',
        pinned: true,
      }),
    );
  });
});
