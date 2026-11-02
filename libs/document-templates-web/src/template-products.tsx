import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@aramo/fe-foundation';

import './template-products.css';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §2.1/§2.2/§2.5 — template
// product tags. The stored value is the entitlement capability key (ats, sign — the
// server's TEMPLATE_PRODUCT_KEYS in libs/documents); people see ATS / Sign. This ONE
// label map is used by every surface (Platform Admin, Studio, Org Home, Sign), and the
// multi-select dropdown below replaces every free-text product tag input: tags are a
// fixed choice, never typed.

/** The template product keys (mirrors TEMPLATE_PRODUCT_KEYS in libs/documents). */
export const TEMPLATE_PRODUCT_KEYS = ['ats', 'sign'] as const;
export type TemplateProductKey = (typeof TEMPLATE_PRODUCT_KEYS)[number];

/** Display label per key. */
export const TEMPLATE_PRODUCT_LABELS: Readonly<Record<TemplateProductKey, string>> = {
  ats: 'ATS',
  sign: 'Sign',
};

export function isTemplateProductKey(value: unknown): value is TemplateProductKey {
  return typeof value === 'string' && (TEMPLATE_PRODUCT_KEYS as readonly string[]).includes(value);
}

/** "ats" → "ATS". An unknown value is shown as stored (the server only returns keys). */
export function templateProductLabel(key: string): string {
  return isTemplateProductKey(key) ? TEMPLATE_PRODUCT_LABELS[key] : key;
}

/** ["ats", "sign"] → "ATS · Sign" (key order). */
export function templateProductsLine(keys: readonly string[]): string {
  return orderedProducts(keys).map(templateProductLabel).join(' · ');
}

/** The keys in canonical order (unknown values last, as stored). */
export function orderedProducts(keys: readonly string[]): string[] {
  const known = TEMPLATE_PRODUCT_KEYS.filter((k) => keys.includes(k));
  return [...known, ...keys.filter((k) => !isTemplateProductKey(k))];
}

export interface ProductTagsSelectProps {
  readonly label: string;
  /** The selected keys. */
  readonly value: readonly string[];
  readonly onChange: (next: TemplateProductKey[]) => void;
  readonly disabled?: boolean;
  readonly helper?: string;
  /** The keys offered (default: every template product key). */
  readonly options?: readonly TemplateProductKey[];
  /** The host's field / label classes (Studio: ts-field; Platform Admin: pw-field). */
  readonly fieldClassName?: string;
  readonly labelClassName?: string;
  readonly helperClassName?: string;
}

/**
 * The product tags dropdown: a button showing the chosen products (ATS · Sign) that opens a
 * multi-select list. Each option toggles; the list stays open until Escape, a click
 * outside or the button. The caller decides what an empty choice means (publishing
 * needs at least one — the server refuses otherwise).
 */
export function ProductTagsSelect({
  label,
  value,
  onChange,
  disabled = false,
  helper,
  options = TEMPLATE_PRODUCT_KEYS,
  fieldClassName = 'dt-ptags-field',
  labelClassName = 'dt-ptags-label',
  helperClassName = 'dt-ptags-helper',
}: ProductTagsSelectProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const selected = orderedProducts(value);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      if (wrap.current !== null && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    wrap.current?.querySelector<HTMLElement>('[role="option"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const toggle = (k: TemplateProductKey): void => {
    const next = value.includes(k) ? value.filter((x) => x !== k) : [...value, k];
    onChange(TEMPLATE_PRODUCT_KEYS.filter((x) => next.includes(x)));
  };

  return (
    <div className={fieldClassName}>
      <span className={labelClassName} id={`${id}-label`}>
        {label}
      </span>
      <div className="dt-ptags" ref={wrap}>
        <Button
          ref={trigger}
          unstyled
          className="dt-ptags__btn"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-labelledby={`${id}-label ${id}-value`}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
        >
          <span id={`${id}-value`} className={selected.length === 0 ? 'dt-ptags__placeholder' : 'dt-ptags__value'}>
            {selected.length === 0 ? 'Choose products' : selected.map(templateProductLabel).join(' · ')}
          </span>
          <span className="dt-ptags__caret" aria-hidden="true">
            ▾
          </span>
        </Button>
        {open ? (
          <div role="listbox" aria-multiselectable="true" aria-labelledby={`${id}-label`} className="dt-ptags__list">
            {options.map((k) => {
              const on = value.includes(k);
              return (
                <Button key={k} unstyled role="option" aria-selected={on} className={`dt-ptags__opt${on ? ' dt-ptags__opt--on' : ''}`} onClick={() => toggle(k)}>
                  <span className="dt-ptags__check" aria-hidden="true">
                    {on ? '✓' : ''}
                  </span>
                  {TEMPLATE_PRODUCT_LABELS[k]}
                </Button>
              );
            })}
          </div>
        ) : null}
      </div>
      {helper !== undefined ? <span className={helperClassName}>{helper}</span> : null}
    </div>
  );
}
