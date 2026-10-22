import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EducationEntryView } from '../talent-360/talent-360-types';

import { EducationEditor } from './EducationEditor';

// ATS-QA-1 I-4 — the education list + editor. Each change is saved immediately
// through the education API; the list shown is the server's current education.

const RESUME: EducationEntryView = {
  id: 'edu-1',
  institution_name: 'State Universty',
  degree_name: 'BS',
  field_of_study: 'Computer Science',
  conferred_date: '2012-05-15',
  source: 'resume',
  source_document_id: 'doc-1',
  source_refs: ['b3'],
  corrects_entry_id: null,
  recorded_at: '2026-09-01T00:00:00.000Z',
};
const CORRECTED: EducationEntryView = {
  ...RESUME,
  id: 'edu-2',
  institution_name: 'State University',
  source: 'manual',
  source_document_id: null,
  source_refs: [],
  corrects_entry_id: 'edu-1',
};

type Handler = (req: { url: string; method: string; body: unknown }) => { status: number; body: unknown };

function installFetch(handler: Handler) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const res = handler({ url, method, body });
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json' } });
  });
  return calls;
}

function Harness({ initial, canEdit = true }: { initial: readonly EducationEntryView[]; canEdit?: boolean }) {
  const [entries, setEntries] = useState(initial);
  return <EducationEditor talentId="tal-1" entries={entries} canEdit={canEdit} onChange={setEntries} variant="t360" />;
}

afterEach(() => vi.restoreAllMocks());

describe('EducationEditor', () => {
  it('lists the current entries with plain source labels', () => {
    render(<Harness initial={[CORRECTED]} />);
    const row = screen.getByTestId('education-edu-2');
    expect(within(row).getByText('BS')).toBeInTheDocument();
    expect(row).toHaveTextContent('Computer Science · State University');
    expect(within(row).getByText('Corrected by a recruiter')).toBeInTheDocument();
  });

  it('says so when there is no education (never a placeholder entry)', () => {
    render(<Harness initial={[]} />);
    expect(screen.getByText('No education on record.')).toBeInTheDocument();
  });

  it('without talent:edit there is no Add / Edit / Remove', () => {
    render(<Harness initial={[RESUME]} canEdit={false} />);
    expect(screen.queryByText('+ Add education')).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit BS/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove BS/ })).toBeNull();
  });

  it('add posts the entry (empty optional fields as null) and shows the server list', async () => {
    const calls = installFetch(() => ({ status: 201, body: { entry_id: 'edu-3', education: [{ ...CORRECTED, id: 'edu-3', corrects_entry_id: null }] } }));
    render(<Harness initial={[]} />);
    fireEvent.click(screen.getByText('+ Add education'));
    fireEvent.change(screen.getByLabelText('Institution'), { target: { value: ' State University ' } });
    fireEvent.change(screen.getByLabelText('Degree'), { target: { value: 'BS' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));
    await waitFor(() => expect(screen.getByTestId('education-edu-3')).toBeInTheDocument());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toContain('/v1/talent-records/tal-1/education');
    expect(calls[0]?.body).toEqual({ institution_name: 'State University', degree_name: 'BS', field_of_study: null, conferred_date: null });
    expect(screen.getByText('Entered manually')).toBeInTheDocument();
  });

  it('refuses to send without institution and degree', () => {
    const calls = installFetch(() => ({ status: 500, body: {} }));
    render(<Harness initial={[]} />);
    fireEvent.click(screen.getByText('+ Add education'));
    fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));
    expect(screen.getAllByText('Required')).toHaveLength(2);
    expect(calls).toHaveLength(0);
  });

  it('a correction PUTs the full entry to the entry id and replaces the row', async () => {
    const calls = installFetch(() => ({ status: 200, body: { entry_id: 'edu-2', education: [CORRECTED] } }));
    render(<Harness initial={[RESUME]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit BS · State Universty' }));
    fireEvent.change(screen.getByLabelText('Institution'), { target: { value: 'State University' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    await waitFor(() => expect(screen.getByTestId('education-edu-2')).toBeInTheDocument());
    expect(screen.queryByTestId('education-edu-1')).toBeNull();
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toContain('/v1/talent-records/tal-1/education/edu-1');
    expect(calls[0]?.body).toEqual({
      institution_name: 'State University',
      degree_name: 'BS',
      field_of_study: 'Computer Science',
      conferred_date: '2012-05-15',
    });
  });

  it('remove asks first, then DELETEs and drops the row', async () => {
    const calls = installFetch(() => ({ status: 200, body: { entry_id: 'edu-1', education: [] } }));
    render(<Harness initial={[RESUME]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove BS · State Universty' }));
    expect(screen.getByText('Remove this entry? It is kept in history.')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.getByText('No education on record.')).toBeInTheDocument());
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url).toContain('/v1/talent-records/tal-1/education/edu-1');
  });

  it('an entry already changed elsewhere (409) keeps the form open with a plain message', async () => {
    installFetch(() => ({ status: 409, body: { error: { code: 'INVALID_REQUEST', message: 'x', request_id: 'r', details: {} } } }));
    render(<Harness initial={[RESUME]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit BS · State Universty' }));
    fireEvent.change(screen.getByLabelText('Degree'), { target: { value: 'BSc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This entry was already changed by someone else.');
    expect(screen.getByRole('button', { name: 'Save correction' })).toBeInTheDocument();
  });
});
