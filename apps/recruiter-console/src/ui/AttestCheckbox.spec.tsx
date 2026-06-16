import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AttestCheckbox } from './AttestCheckbox';

describe('AttestCheckbox', () => {
  it('reports toggles through onChange', () => {
    const onChange = vi.fn();
    render(
      <AttestCheckbox checked={false} onChange={onChange}>
        I confirm this talent is ready for submittal.
      </AttestCheckbox>,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('adds the checked highlight class when checked', () => {
    const { container } = render(
      <AttestCheckbox checked onChange={() => undefined}>
        Confirmed
      </AttestCheckbox>,
    );
    expect((container.firstChild as HTMLElement).className).toContain('rc-attest--checked');
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('gates a downstream action until all are checked (friction)', () => {
    function Harness() {
      const [a, setA] = useState(false);
      const [b, setB] = useState(false);
      return (
        <>
          <AttestCheckbox checked={a} onChange={setA}>
            one
          </AttestCheckbox>
          <AttestCheckbox checked={b} onChange={setB}>
            two
          </AttestCheckbox>
          <button type="button" disabled={!(a && b)}>
            Submit
          </button>
        </>
      );
    }
    render(<Harness />);
    const submit = screen.getByRole('button', { name: 'Submit' });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'one' }));
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'two' }));
    expect(submit).toBeEnabled();
  });
});
