import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TalentForm } from './TalentForm';
import type {
  CreateTalentRecordRequest,
  TalentRecordPrefill,
  TalentRecordView,
  UpdateTalentRecordRequest,
} from './types';

function makeTalent(overrides: Partial<TalentRecordView> = {}): TalentRecordView {
  return {
    id: 'tal-1',
    tenant_id: 't',
    site_id: null,
    first_name: 'Ada',
    last_name: 'Lovelace',
    email1: 'ada@example.com',
    email2: null,
    phone_home: null,
    phone_cell: null,
    phone_work: null,
    address: null,
    address2: null,
    city: null,
    state: null,
    zip: null,
    source: null,
    key_skills: null,
    current_employer: null,
    current_pay: null,
    desired_pay: null,
    availability_status: null,
    engagement_type: null,
    date_available: null,
    can_relocate: false,
    is_hot: false,
    notes: null,
    web_site: null,
    best_time_to_call: null,
    owner_id: null,
    entered_by_id: null,
    core_talent_id: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

describe('TalentForm — CREATE', () => {
  it('submit disabled until first_name + last_name are non-empty', () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<TalentForm mode="create" onSubmit={onSubmit} onCancel={vi.fn()} />);
    const btn = screen.getByRole('button', { name: /create talent/i });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('First name'), {
      target: { value: 'Ada' },
    });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Last name'), {
      target: { value: 'Lovelace' },
    });
    expect(btn).toBeEnabled();
  });

  it('submits POST body with only non-empty fields (free-text key_skills + pay; trims names)', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<TalentForm mode="create" onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('First name'), {
      target: { value: '  Ada  ' },
    });
    fireEvent.change(screen.getByLabelText('Last name'), {
      target: { value: '  Lovelace  ' },
    });
    fireEvent.change(screen.getByLabelText('Primary email'), {
      target: { value: 'ada@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Key skills'), {
      target: { value: 'Bernoulli numbers, mechanical computing' },
    });
    fireEvent.change(screen.getByLabelText('Current pay'), {
      target: { value: '$85k' },
    });
    fireEvent.click(screen.getByLabelText('Can relocate'));
    fireEvent.click(screen.getByRole('button', { name: /create talent/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const body = onSubmit.mock.calls[0]?.[0] as CreateTalentRecordRequest;
    expect(body.first_name).toBe('Ada');
    expect(body.last_name).toBe('Lovelace');
    expect(body.email1).toBe('ada@example.com');
    expect(body.key_skills).toBe('Bernoulli numbers, mechanical computing');
    expect(body.current_pay).toBe('$85k');
    expect(body.can_relocate).toBe(true);
    // Optional fields not filled are NOT in the body (don't blank them).
    expect(body).not.toHaveProperty('phone_home');
    expect(body).not.toHaveProperty('notes');
  });

  it('applies a résumé prefill into the form (merges; does not overwrite existing edits to OTHER fields)', async () => {
    const initialPrefill: TalentRecordPrefill | undefined = undefined;
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <TalentForm
        mode="create"
        prefill={initialPrefill}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    // Recruiter manually types notes BEFORE the prefill arrives.
    fireEvent.change(screen.getByLabelText('Notes'), {
      target: { value: 'manual note kept' },
    });
    // Parent's prefill arrives.
    rerender(
      <TalentForm
        mode="create"
        prefill={{
          first_name: 'Ada',
          last_name: 'Lovelace',
          email1: 'ada@example.com',
          key_skills: 'Bernoulli numbers',
        }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(
        (screen.getByLabelText('First name') as HTMLInputElement).value,
      ).toBe('Ada');
    });
    expect((screen.getByLabelText('Last name') as HTMLInputElement).value).toBe(
      'Lovelace',
    );
    expect((screen.getByLabelText('Primary email') as HTMLInputElement).value).toBe(
      'ada@example.com',
    );
    expect((screen.getByLabelText('Key skills') as HTMLTextAreaElement).value).toBe(
      'Bernoulli numbers',
    );
    // The recruiter's manual note is preserved (not overwritten).
    expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe(
      'manual note kept',
    );
  });
});

describe('TalentForm — EDIT (true PATCH semantics; R4 omit-vs-null discipline)', () => {
  it('pre-fills from initial; submits an EMPTY PATCH when nothing changed', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <TalentForm
        mode="edit"
        initial={makeTalent({ notes: 'hi' })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Ada');
    expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe('hi');
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const body = onSubmit.mock.calls[0]?.[0] as UpdateTalentRecordRequest;
    expect(Object.keys(body)).toHaveLength(0);
  });

  it('sends explicit null when a nullable field is cleared (notes / key_skills / etc.)', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <TalentForm
        mode="edit"
        initial={makeTalent({ notes: 'hi', key_skills: 'java' })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Key skills'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const body = onSubmit.mock.calls[0]?.[0] as UpdateTalentRecordRequest;
    expect(body).toEqual({ notes: null, key_skills: null });
  });

  it('sends the new value when a field is changed', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <TalentForm
        mode="edit"
        initial={makeTalent()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('First name'), {
      target: { value: 'Augusta' },
    });
    fireEvent.click(screen.getByLabelText('Hot'));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const body = onSubmit.mock.calls[0]?.[0] as UpdateTalentRecordRequest;
    expect(body.first_name).toBe('Augusta');
    expect(body.is_hot).toBe(true);
    // No other fields in the body — only what changed.
    expect(Object.keys(body).sort()).toEqual(['first_name', 'is_hot']);
  });

  // RULING 4 — the Core-Talent link field is structurally locked out of
  // the form (dedicated /link routes own it).
  it('does NOT surface the Core-Talent link field anywhere', () => {
    render(
      <TalentForm
        mode="edit"
        initial={makeTalent()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(/core.?talent.?id/i)).toBeNull();
    expect(screen.queryByText(/core.?talent.?id/i)).toBeNull();
  });

  // RULING 4 — key_skills is a textarea (free-text). The form must NOT
  // expose a structured selector UI ("Add skill" buttons or chip lists).
  it('renders key_skills as a textarea (NOT a structured selector)', () => {
    render(
      <TalentForm
        mode="edit"
        initial={makeTalent()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const el = screen.getByLabelText('Key skills');
    expect(el.tagName).toBe('TEXTAREA');
    expect(screen.queryByRole('button', { name: /add skill/i })).toBeNull();
  });
});

describe('TalentForm — cancel', () => {
  it('clicking Cancel fires onCancel', () => {
    const onCancel = vi.fn();
    render(
      <TalentForm
        mode="create"
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
