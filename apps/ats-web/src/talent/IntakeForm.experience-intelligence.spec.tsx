import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { IntakeForm } from './IntakeForm';
import { emptyIntakeState } from './intake-fields';
import type { CertificationDraft, EducationDraft, WorkHistoryDraft } from './types';

// HF2 §29 — the recruiter review surface: a concise experience preview + the
// optionally-expandable "skills used" / "projects / context", and the résumé-
// derived education + certifications review. Read-only intelligence; the review
// optimizes for the recruiter (not an atomic-claim editor).

const NOOP = {
  onField: vi.fn(),
  onToggle: vi.fn(),
  onWorkHistoryField: vi.fn(),
  onAddWorkHistory: vi.fn(),
  onRemoveWorkHistory: vi.fn(),
};

function renderForm(opts: {
  workHistory: WorkHistoryDraft[];
  education?: EducationDraft[];
  certifications?: CertificationDraft[];
}) {
  render(
    <IntakeForm
      values={emptyIntakeState()}
      provenance={{}}
      workHistory={opts.workHistory}
      education={opts.education ?? []}
      certifications={opts.certifications ?? []}
      {...NOOP}
    />,
  );
}

describe('IntakeForm — HF2 Experience Intelligence review (§29)', () => {
  it('binds experience_summary into the editable "Work experience" field + expandable skills/projects', () => {
    renderForm({
      workHistory: [
        {
          employer_name: 'Northstar',
          role_title: 'Cloud Engineer',
          experience_summary: 'Led the platform migration end to end.',
          skill_usage: [{ surface_form: 'Kubernetes', version: '1.27' }],
          projects: [{ project_name: 'Atlas', context: 'zero-downtime cutover' }],
        },
      ],
    });
    // The summary is now the EDITABLE Work experience field (not read-only text).
    const field = screen.getByLabelText('Work experience 1') as HTMLTextAreaElement;
    expect(field.value).toBe('Led the platform migration end to end.');
    // Supporting intelligence remains expandable.
    expect(screen.getByText('Skills used (1)')).toBeInTheDocument();
    expect(screen.getByText(/Kubernetes/)).toBeInTheDocument();
    expect(screen.getByText('Projects / context (1)')).toBeInTheDocument();
    expect(screen.getByText('Atlas')).toBeInTheDocument();
  });

  it('shows nothing extra when a role carries no intelligence', () => {
    renderForm({
      workHistory: [{ employer_name: 'Acme', role_title: 'Engineer' }],
    });
    expect(screen.queryByText(/Skills used/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Projects \/ context/)).not.toBeInTheDocument();
  });

  it('renders résumé-derived education + certifications read-only (FROM RESUME)', () => {
    renderForm({
      workHistory: [],
      education: [
        { institution_name: 'MIT', degree_name: 'BSc', field_of_study: 'Computer Science', conferred_date: 'May 2018' },
      ],
      certifications: [{ certification_name: 'CKA', issuer_name: 'CNCF' }],
    });
    expect(screen.getByText('BSc')).toBeInTheDocument();
    expect(screen.getByText(/MIT/)).toBeInTheDocument();
    expect(screen.getByText('CKA')).toBeInTheDocument();
    expect(screen.getByText(/CNCF/)).toBeInTheDocument();
  });

  it('falls back to the "after creation" note when no education/certifications were extracted', () => {
    renderForm({ workHistory: [] });
    expect(
      screen.getByText(/Added on the Talent record after creation/),
    ).toBeInTheDocument();
  });
});
