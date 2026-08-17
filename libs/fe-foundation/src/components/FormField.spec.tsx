import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FormField } from './FormField';

// T10-B3/F-036 (S1) — accessible field semantics without bespoke consumer ARIA.

describe('FormField accessibility', () => {
  it('associates the label with a native control (getByLabelText resolves it)', () => {
    render(
      <FormField label="Branch name">
        <input type="text" />
      </FormField>,
    );
    const input = screen.getByLabelText('Branch name');
    expect(input.tagName).toBe('INPUT');
    // The label is a real <label htmlFor> pointing at the control's id.
    const label = screen.getByText('Branch name').closest('label');
    expect(label).not.toBeNull();
    expect(label).toHaveAttribute('for', input.getAttribute('id'));
  });

  it('associates help text via aria-describedby', () => {
    render(
      <FormField label="Email" helper="We never share it.">
        <input type="email" />
      </FormField>,
    );
    const input = screen.getByLabelText('Email');
    const described = input.getAttribute('aria-describedby');
    expect(described).not.toBeNull();
    const helper = document.getElementById(described as string);
    expect(helper).toHaveTextContent('We never share it.');
  });

  it('associates an error, sets aria-invalid, and announces it (role=alert)', () => {
    render(
      <FormField label="Name" error="Name is required.">
        <input type="text" />
      </FormField>,
    );
    const input = screen.getByLabelText('Name');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const described = input.getAttribute('aria-describedby');
    const errorEl = document.getElementById(described as string);
    expect(errorEl).toHaveTextContent('Name is required.');
    expect(screen.getByRole('alert')).toHaveTextContent('Name is required.');
  });

  it('communicates required via aria-required and a visible glyph (not colour alone)', () => {
    render(
      <FormField label="Title" required>
        <input type="text" />
      </FormField>,
    );
    expect(screen.getByLabelText(/Title/)).toHaveAttribute(
      'aria-required',
      'true',
    );
    // A visible non-colour indicator (glyph) sits in the label.
    expect(
      screen.getByText('Title').closest('label')?.textContent,
    ).toContain('*');
  });

  it('does not clobber a child that already carries id / aria-describedby', () => {
    render(
      <FormField label="Notes" error="Too long.">
        <textarea id="my-notes" aria-describedby="external-hint" />
      </FormField>,
    );
    const ta = screen.getByLabelText('Notes');
    expect(ta).toHaveAttribute('id', 'my-notes');
    const described = ta.getAttribute('aria-describedby') ?? '';
    // Both the pre-existing hint AND the generated error id are present.
    expect(described).toContain('external-hint');
    expect(described.split(' ').length).toBeGreaterThan(1);
  });

  it('supports a prop-spreading custom control (composability preserved)', () => {
    function Passthrough(props: Record<string, unknown>) {
      return <input {...props} />;
    }
    render(
      <FormField label="Custom">
        <Passthrough />
      </FormField>,
    );
    expect(screen.getByLabelText('Custom').tagName).toBe('INPUT');
  });

  it('renders non-element children without crashing (fallback, no association)', () => {
    render(
      <FormField label="Group">
        <>
          <input type="radio" name="g" value="a" />
          <input type="radio" name="g" value="b" />
        </>
      </FormField>,
    );
    expect(screen.getByText('Group')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });
});
