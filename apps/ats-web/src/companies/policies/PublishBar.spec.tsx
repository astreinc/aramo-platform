import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { PublishBar } from './PublishBar';

describe('PublishBar (§11 change summary)', () => {
  it('lists the before→after change summary and enables publish', () => {
    render(
      <PublishBar
        changes={['Bill rate: Inherit → Required (Not allowed)', 'Voice engagement: Not required → Required']}
        publishing={false}
        onCancel={vi.fn()}
        onPublish={vi.fn()}
      />,
    );
    expect(screen.getByText('2 changes')).toBeInTheDocument();
    expect(screen.getByText('Bill rate: Inherit → Required (Not allowed)')).toBeInTheDocument();
    expect(screen.getByText('Voice engagement: Not required → Required')).toBeInTheDocument();
    expect(screen.getByText('Publish changes')).not.toBeDisabled();
  });

  it('disables publish and shows no summary when there are no changes', () => {
    render(<PublishBar changes={[]} publishing={false} onCancel={vi.fn()} onPublish={vi.fn()} />);
    expect(screen.getByText('No changes yet')).toBeInTheDocument();
    expect(screen.getByText('Publish changes')).toBeDisabled();
  });

  it('disables both actions while publishing', () => {
    render(<PublishBar changes={['x: a → b']} publishing={true} onCancel={vi.fn()} onPublish={vi.fn()} />);
    expect(screen.getByText('Publish changes')).toBeDisabled();
    expect(screen.getByText('Cancel')).toBeDisabled();
  });
});
