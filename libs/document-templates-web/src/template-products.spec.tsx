import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  ProductTagsSelect,
  TEMPLATE_PRODUCT_KEYS,
  TEMPLATE_PRODUCT_LABELS,
  isTemplateProductKey,
  orderedProducts,
  templateProductLabel,
  templateProductsLine,
  type TemplateProductKey,
} from './template-products';

// TEMPLATE-PRODUCT-1 §2.2/§2.5 — the one product label map and the product tags dropdown.

describe('template product keys and labels', () => {
  it('keys are ats + sign, shown as ATS / Sign', () => {
    expect(TEMPLATE_PRODUCT_KEYS).toEqual(['ats', 'sign']);
    expect(TEMPLATE_PRODUCT_LABELS).toEqual({ ats: 'ATS', sign: 'Sign' });
    expect(templateProductLabel('sign')).toBe('Sign');
    expect(templateProductLabel('LEGACY')).toBe('LEGACY');
    expect(isTemplateProductKey('ats')).toBe(true);
    expect(isTemplateProductKey('ATS')).toBe(false);
  });

  it('orders keys canonically and joins labels', () => {
    expect(orderedProducts(['sign', 'ats'])).toEqual(['ats', 'sign']);
    expect(templateProductsLine(['sign', 'ats'])).toBe('ATS · Sign');
    expect(templateProductsLine([])).toBe('');
  });
});

function Harness({ initial, options }: { readonly initial: TemplateProductKey[]; readonly options?: readonly TemplateProductKey[] }) {
  const [v, setV] = useState<TemplateProductKey[]>(initial);
  return (
    <>
      <ProductTagsSelect label="Products" value={v} onChange={setV} {...(options !== undefined ? { options } : {})} />
      <output data-testid="value">{JSON.stringify(v)}</output>
    </>
  );
}

describe('ProductTagsSelect', () => {
  it('opens a multi-select list; options toggle and keep the canonical order', () => {
    render(<Harness initial={['sign']} />);
    const trigger = screen.getByRole('button', { name: 'Products Sign' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    const list = screen.getByRole('listbox');
    expect(list).toHaveAttribute('aria-multiselectable', 'true');
    expect(screen.getByRole('option', { name: 'Sign' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('option', { name: 'ATS' }));
    expect(screen.getByTestId('value')).toHaveTextContent('["ats","sign"]');
    fireEvent.click(screen.getByRole('option', { name: 'Sign' }));
    fireEvent.click(screen.getByRole('option', { name: 'ATS' }));
    expect(screen.getByTestId('value')).toHaveTextContent('[]');
    expect(screen.getByRole('button', { name: 'Products Choose products' })).toBeInTheDocument();
  });

  it('closes on Escape and offers only the given options', () => {
    render(<Harness initial={[]} options={['sign']} />);
    fireEvent.click(screen.getByRole('button', { name: /Products/ }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Sign']);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
