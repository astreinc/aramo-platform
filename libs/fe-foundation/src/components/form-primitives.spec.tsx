import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';

import { Button } from './Button';
import { Checkbox } from './Checkbox';
import { FormField } from './FormField';
import { Input } from './Input';
import { Select } from './Select';
import { TextArea } from './TextArea';
import { TextField } from './TextField';

// G1 (Aramo-UI-HotFix-Console-Defect-Register-v1_0-LOCKED) — the standard
// form-control primitives. Proof: each renders its native element with the
// token class, is full-width by class, forwards its ref, spreads props, and
// composes as a FormField child (so app code never needs a bare control).

describe('G1 form primitives', () => {
  it('Input renders a native <input> with tc-input, forwards ref, spreads props', () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input ref={ref} placeholder="Email subject" defaultValue="x" />);
    const el = screen.getByPlaceholderText('Email subject');
    expect(el.tagName).toBe('INPUT');
    expect(el).toHaveClass('tc-input');
    expect(el).toHaveAttribute('type', 'text');
    expect(ref.current).toBe(el);
  });

  it('TextArea renders a native <textarea> with tc-textarea and forwards ref', () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<TextArea ref={ref} aria-label="Body" rows={8} />);
    const el = screen.getByLabelText('Body');
    expect(el.tagName).toBe('TEXTAREA');
    expect(el).toHaveClass('tc-textarea');
    expect(el).toHaveAttribute('rows', '8');
    expect(ref.current).toBe(el);
  });

  it('Select renders a native <select> with tc-select and forwards ref', () => {
    const ref = createRef<HTMLSelectElement>();
    render(
      <Select ref={ref} aria-label="Arrangement" defaultValue="remote">
        <option value="onsite">Onsite</option>
        <option value="remote">Remote</option>
      </Select>,
    );
    const el = screen.getByLabelText('Arrangement');
    expect(el.tagName).toBe('SELECT');
    expect(el).toHaveClass('tc-select');
    expect(ref.current).toBe(el);
  });

  it('a caller-supplied className is merged, not clobbered', () => {
    render(<Input aria-label="k" className="w-half" />);
    const el = screen.getByLabelText('k');
    expect(el).toHaveClass('tc-input');
    expect(el).toHaveClass('w-half');
  });

  it('Button unstyled carries ONLY the caller className (no tc-button) — faithful rc-* migration', () => {
    render(
      <>
        <Button variant="primary">styled</Button>
        <Button unstyled className="rc-btn rc-btn--primary">bare</Button>
      </>,
    );
    const styled = screen.getByText('styled');
    const unstyled = screen.getByText('bare');
    // Default keeps the standard base + variant classes.
    expect(styled).toHaveClass('tc-button');
    expect(styled).toHaveClass('tc-button--primary');
    // Unstyled imposes NO fe-foundation classes — only what the caller passed.
    expect(unstyled).not.toHaveClass('tc-button');
    expect(unstyled).toHaveClass('rc-btn');
    expect(unstyled).toHaveClass('rc-btn--primary');
    // Still a real, typed <button> going through the standard component.
    expect(unstyled.tagName).toBe('BUTTON');
    expect(unstyled).toHaveAttribute('type', 'button');
  });

  it('Input/Select/TextArea unstyled keep ONLY the caller className (no tc-* base)', () => {
    render(
      <>
        <Input aria-label="i" unstyled className="rc-input" />
        <Select aria-label="s" unstyled className="rc-select">
          <option value="x">x</option>
        </Select>
        <TextArea aria-label="t" unstyled className="rc-textarea" />
      </>,
    );
    const i = screen.getByLabelText('i');
    expect(i).not.toHaveClass('tc-input');
    expect(i).toHaveClass('rc-input');
    const s = screen.getByLabelText('s');
    expect(s).not.toHaveClass('tc-select');
    expect(s).toHaveClass('rc-select');
    const t = screen.getByLabelText('t');
    expect(t).not.toHaveClass('tc-textarea');
    expect(t).toHaveClass('rc-textarea');
  });

  it('Checkbox renders <input type="checkbox"> with tc-checkbox + forwards ref', () => {
    const ref = createRef<HTMLInputElement>();
    render(<Checkbox ref={ref} aria-label="agree" readOnly checked />);
    const box = screen.getByLabelText('agree');
    expect(box.tagName).toBe('INPUT');
    expect(box).toHaveAttribute('type', 'checkbox');
    expect(box).toHaveClass('tc-checkbox');
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(ref.current).toBe(box);
  });

  it('Checkbox unstyled keeps only the caller className (rc-attest__box)', () => {
    render(<Checkbox aria-label="a" unstyled className="rc-attest__box" readOnly checked />);
    const box = screen.getByLabelText('a');
    expect(box).not.toHaveClass('tc-checkbox');
    expect(box).toHaveClass('rc-attest__box');
  });

  it('TextField composes FormField + Input: the label resolves to the input', () => {
    const ref = createRef<HTMLInputElement>();
    render(<TextField ref={ref} label="Job title" required />);
    const input = screen.getByLabelText('Job title', { exact: false });
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveClass('tc-input');
    // FormField injected an id and wired aria-required; the ref still reaches the input.
    expect(input).toHaveAttribute('aria-required', 'true');
    expect(ref.current).toBe(input);
  });
});
