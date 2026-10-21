import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { platformSession } from '../skills/test-session';

import { documentTemplatesApi, type TemplateVariable } from './document-templates-api';
import { TemplateVariablesView } from './TemplateVariablesView';

const READ = ['platform:document_template:read'];
const MANAGE = ['platform:document_template:read', 'platform:document_template:manage'];

const VARS: TemplateVariable[] = [
  {
    id: 'a1',
    key: 'talent.desired_pay_rate',
    label: 'Desired pay rate',
    group_label: 'Talent',
    data_type: 'TEXT',
    products: ['ATS'],
    ats_binding_key: 'talent.desired_pay_rate',
    sample_value: '$70/hr',
    active: true,
    created_at: '2026-10-21T00:00:00.000Z',
    updated_at: '2026-10-21T00:00:00.000Z',
  },
];

describe('TemplateVariablesView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists the catalog (key, label, group, ATS binding, sample, status)', async () => {
    vi.spyOn(documentTemplatesApi, 'listVariables').mockResolvedValue({ variables: VARS });
    render(<TemplateVariablesView session={platformSession(READ)} />);
    expect(await screen.findByText('Desired pay rate')).toBeInTheDocument();
    expect(screen.getAllByText('talent.desired_pay_rate')).toHaveLength(2);
    expect(screen.getByText('$70/hr')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add variable' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit talent.desired_pay_rate' })).not.toBeInTheDocument();
  });

  it('manage: Add variable posts a new catalog row', async () => {
    vi.spyOn(documentTemplatesApi, 'listVariables').mockResolvedValue({ variables: VARS });
    const create = vi.spyOn(documentTemplatesApi, 'createVariable').mockResolvedValue({ ...VARS[0]!, id: 'b', key: 'organization.name' });
    render(<TemplateVariablesView session={platformSession(MANAGE)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add variable' }));
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'organization.name' } });
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Organization name' } });
    fireEvent.change(screen.getByLabelText('Group'), { target: { value: 'Organization' } });
    fireEvent.change(screen.getByLabelText('Products'), { target: { value: 'ATS, SIGN' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        key: 'organization.name',
        label: 'Organization name',
        group_label: 'Organization',
        data_type: 'TEXT',
        products: ['ATS', 'SIGN'],
        ats_binding_key: null,
        sample_value: null,
        active: true,
      }),
    );
  });

  it('manage: Edit keeps the key read-only and patches only the editable fields', async () => {
    vi.spyOn(documentTemplatesApi, 'listVariables').mockResolvedValue({ variables: VARS });
    const update = vi.spyOn(documentTemplatesApi, 'updateVariable').mockResolvedValue(VARS[0]!);
    render(<TemplateVariablesView session={platformSession(MANAGE)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit talent.desired_pay_rate' }));
    expect(screen.getByLabelText('Key')).toHaveAttribute('readonly');
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Desired rate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const [id, body] = update.mock.calls[0]!;
    expect(id).toBe('a1');
    expect(body).toMatchObject({ label: 'Desired rate', ats_binding_key: 'talent.desired_pay_rate' });
    expect(body).not.toHaveProperty('key');
  });
});
