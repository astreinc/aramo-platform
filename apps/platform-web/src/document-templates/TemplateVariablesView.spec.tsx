import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '@aramo/fe-foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { platformSession } from '../skills/test-session';

import { documentTemplatesApi, type TemplateVariable } from './document-templates-api';
import {
  BINDING_SHAPE_ERROR,
  KEY_EXISTS_ERROR,
  KEY_SHAPE_ERROR,
  TemplateVariablesView,
  dataTypeCode,
  dataTypeLabel,
  keyIsValid,
  variableErrorText,
} from './TemplateVariablesView';

// PLATFORM-UX-1 F-8 (handoff §9 Template variables) — the catalog table, the
// Add/Edit dialog (key disabled after creation; pattern + length; key exists)
// and the view-only state for :read.

const READ = ['platform:document_template:read'];
const MANAGE = ['platform:document_template:read', 'platform:document_template:manage'];

const VAR_A: TemplateVariable = {
  id: 'a1',
  key: 'talent.desired_pay_rate',
  label: 'Desired pay rate',
  group_label: 'Talent',
  data_type: 'MULTILINE_TEXT',
  products: ['ATS', 'SIGN'],
  ats_binding_key: 'talent.desired_pay_rate',
  sample_value: '$70/hr',
  active: true,
  created_at: '2026-10-21T00:00:00.000Z',
  updated_at: '2026-10-21T00:00:00.000Z',
};

const VARS: TemplateVariable[] = [
  {
    id: 'a1',
    key: 'talent.desired_pay_rate',
    label: 'Desired pay rate',
    group_label: 'Talent',
    data_type: 'MULTILINE_TEXT',
    products: ['ATS', 'SIGN'],
    ats_binding_key: 'talent.desired_pay_rate',
    sample_value: '$70/hr',
    active: true,
    created_at: '2026-10-21T00:00:00.000Z',
    updated_at: '2026-10-21T00:00:00.000Z',
  },
  {
    id: 'a2',
    key: 'document.issue_date',
    label: 'Issue date',
    group_label: 'Legacy',
    data_type: 'DATE',
    products: [],
    ats_binding_key: null,
    sample_value: null,
    active: false,
    created_at: '2026-10-21T00:00:00.000Z',
    updated_at: '2026-10-21T00:00:00.000Z',
  },
];

function renderView(scopes: string[]) {
  vi.spyOn(documentTemplatesApi, 'listVariables').mockResolvedValue({ variables: VARS });
  return render(<TemplateVariablesView session={platformSession(scopes)} />);
}

describe('template variable helpers', () => {
  it('validates the key pattern and its 64-character cap', () => {
    expect(keyIsValid('talent.first_name')).toBe(true);
    expect(keyIsValid('a.b.c_d')).toBe(true);
    expect(keyIsValid('talent')).toBe(false);
    expect(keyIsValid('Talent.first')).toBe(false);
    expect(keyIsValid('talent.1st')).toBe(false);
    expect(keyIsValid(`a.${'b'.repeat(62)}`)).toBe(true);
    expect(keyIsValid(`a.${'b'.repeat(63)}`)).toBe(false);
  });

  it('labels data types', () => {
    expect(dataTypeLabel('MULTILINE_TEXT')).toBe('Multiline text');
    expect(dataTypeCode('MULTILINE_TEXT')).toBe('MULTILINE TEXT');
  });

  it('maps the server refusals', () => {
    expect(variableErrorText(new ApiError(409, 'exists', 'VALIDATION_ERROR', { reason: 'key_exists' }), 'x')).toBe(KEY_EXISTS_ERROR);
    expect(variableErrorText(new ApiError(400, 'key must be dotted', 'VALIDATION_ERROR', { reason: 'invalid_key' }), 'x')).toBe(KEY_SHAPE_ERROR);
    expect(variableErrorText(new ApiError(400, 'invalid ats_binding_key', 'VALIDATION_ERROR', { reason: 'invalid_key' }), 'x')).toBe(
      BINDING_SHAPE_ERROR,
    );
  });
});

describe('TemplateVariablesView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists the catalog columns, and :read sees the view-only note and no write controls', async () => {
    renderView(READ);
    const row = await screen.findByTestId('variable-talent.desired_pay_rate');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Key',
      'Label',
      'Group',
      'Type',
      'Products',
      'ATS binding',
      'Sample',
      'Status',
      'Actions',
    ]);
    expect(row).toHaveTextContent('talent.desired_pay_rate');
    expect(row).toHaveTextContent('Desired pay rate');
    expect(row).toHaveTextContent('MULTILINE TEXT');
    expect(row).toHaveTextContent('ATSSIGN');
    expect(row).toHaveTextContent('$70/hr');
    expect(row).toHaveTextContent('Active');
    const other = screen.getByTestId('variable-document.issue_date');
    expect(other).toHaveTextContent('Inactive');
    expect(other).toHaveTextContent('—');
    expect(screen.getByRole('note')).toHaveTextContent('View only.');
    expect(screen.getByRole('note')).toHaveTextContent('Manage templates');
    expect(screen.queryByRole('button', { name: '+ Add variable' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit talent.desired_pay_rate' })).toBeNull();
  });

  it('adds a variable: required fields gate commit, then pattern and duplicate checks', async () => {
    const create = vi.spyOn(documentTemplatesApi, 'createVariable').mockResolvedValue(VAR_A);
    renderView(MANAGE);
    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: '+ Add variable' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add variable' });
    expect(dialog).toHaveTextContent('Keys use dotted lowercase segments, for example talent.first_name.');
    const commit = within(dialog).getByRole('button', { name: 'Add variable' });
    expect(commit).toBeDisabled();
    expect(within(dialog).getByText('ATS')).toBeInTheDocument(); // default product tag

    fireEvent.change(within(dialog).getByLabelText('Key'), { target: { value: 'Talent' } });
    fireEvent.change(within(dialog).getByLabelText('Label'), { target: { value: 'Middle name' } });
    fireEvent.change(within(dialog).getByLabelText('Group'), { target: { value: 'Talent' } });
    fireEvent.change(within(dialog).getByLabelText('Data type'), { target: { value: 'TEXT' } });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Sample value'), { target: { value: 'Ann' } });
    expect(commit).toBeEnabled();
    fireEvent.click(commit);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(KEY_SHAPE_ERROR);

    fireEvent.change(within(dialog).getByLabelText('Key'), { target: { value: 'document.issue_date' } });
    fireEvent.click(commit);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(KEY_EXISTS_ERROR);
    expect(create).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText('Key'), { target: { value: 'talent.middle_name' } });
    fireEvent.click(commit);
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        key: 'talent.middle_name',
        label: 'Middle name',
        group_label: 'Talent',
        data_type: 'TEXT',
        products: ['ATS'],
        ats_binding_key: null,
        sample_value: 'Ann',
        active: true,
      }),
    );
  });

  it('shows the server "key exists" refusal', async () => {
    vi.spyOn(documentTemplatesApi, 'createVariable').mockRejectedValue(
      new ApiError(409, 'exists', 'VALIDATION_ERROR', { reason: 'key_exists' }),
    );
    renderView(MANAGE);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add variable' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Key'), { target: { value: 'talent.new_one' } });
    fireEvent.change(within(dialog).getByLabelText('Label'), { target: { value: 'New' } });
    fireEvent.change(within(dialog).getByLabelText('Group'), { target: { value: 'Talent' } });
    fireEvent.change(within(dialog).getByLabelText('Sample value'), { target: { value: 'x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add variable' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(KEY_EXISTS_ERROR);
  });

  it('edits a variable with the key disabled, keeping its group and status', async () => {
    const update = vi.spyOn(documentTemplatesApi, 'updateVariable').mockResolvedValue(VAR_A);
    renderView(MANAGE);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit document.issue_date' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit document.issue_date' });
    expect(dialog).toHaveTextContent('The key can’t change after creation.');
    expect(within(dialog).getByLabelText('Key')).toBeDisabled();
    expect(within(dialog).getByLabelText('Group')).toHaveValue('Legacy');
    expect(within(dialog).getByLabelText('Status')).toHaveValue('INACTIVE');
    fireEvent.change(within(dialog).getByLabelText('ATS binding (optional)'), { target: { value: 'Bad Binding' } });
    fireEvent.change(within(dialog).getByLabelText('Sample value'), { target: { value: '24 Oct 2026' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save variable' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(BINDING_SHAPE_ERROR);
    fireEvent.change(within(dialog).getByLabelText('ATS binding (optional)'), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText('Status'), { target: { value: 'ACTIVE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save variable' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('a2', {
        label: 'Issue date',
        group_label: 'Legacy',
        data_type: 'DATE',
        products: [],
        ats_binding_key: null,
        sample_value: '24 Oct 2026',
        active: true,
      }),
    );
  });
});
