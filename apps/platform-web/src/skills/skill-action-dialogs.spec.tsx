import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { skillsApi, type Skill } from './skills-api';
import { MergeDialog, OverrideDialog } from './skill-action-dialogs';

const LOSER: Skill = {
  id: 'loser', canonical_name: 'K8s Platform', normalized_name: 'k8s platform',
  description: null, status: 'active', merged_into_skill_id: null,
  created_at: '2026-09-18T00:00:00.000Z', updated_at: '2026-09-18T00:00:00.000Z',
};
const WINNER: Skill = {
  id: 'winner', canonical_name: 'Kubernetes', normalized_name: 'kubernetes',
  description: null, status: 'active', merged_into_skill_id: null,
  created_at: '2026-09-18T00:00:00.000Z', updated_at: '2026-09-18T00:00:00.000Z',
};

describe('MergeDialog (typed confirmation)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('names the loser identity and gates Merge behind a winner + acknowledgement', async () => {
    vi.spyOn(skillsApi, 'listSkills').mockResolvedValue({ skills: [LOSER, WINNER] });
    const merge = vi.spyOn(skillsApi, 'mergeSkill');
    render(<MergeDialog loser={LOSER} open onOpenChange={() => undefined} onDone={() => undefined} />);

    // The loser identity is stated explicitly.
    expect(await screen.findByText(/Merge “K8s Platform”/)).toBeInTheDocument();

    // Merge is disabled up front (no winner chosen, not acknowledged).
    const mergeBtn = screen.getByRole('button', { name: 'Merge' });
    expect(mergeBtn).toBeDisabled();

    // Acknowledging alone does NOT enable Merge — a winner is still required.
    fireEvent.click(screen.getByRole('checkbox'));
    expect(mergeBtn).toBeDisabled();

    expect(merge).not.toHaveBeenCalled();
  });
});

describe('OverrideDialog', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requires a reason before it can record the override', async () => {
    const override = vi.spyOn(skillsApi, 'overrideSkill').mockResolvedValue({ ok: true });
    render(<OverrideDialog skill={LOSER} open onOpenChange={() => undefined} onDone={() => undefined} />);

    const recordBtn = screen.getByRole('button', { name: 'Record override' });
    expect(recordBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'duplicate surface' } });
    await waitFor(() => expect(recordBtn).toBeEnabled());
    expect(override).not.toHaveBeenCalled();
  });
});
