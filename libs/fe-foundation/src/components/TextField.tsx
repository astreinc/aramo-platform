import { forwardRef, type ReactNode } from 'react';

import { FormField } from './FormField';
import { Input, type InputProps } from './Input';

// G1 — the common labelled-field composite: FormField (label/helper/error/
// required + accessible id/aria wiring) wrapping the standard Input. forwardRef
// targets the underlying <input>. For non-text controls, compose FormField with
// TextArea/Select directly.
export type TextFieldProps = InputProps & {
  label?: ReactNode;
  helper?: ReactNode;
  error?: ReactNode;
  required?: boolean;
};

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, helper, error, required, ...inputProps },
  ref,
) {
  return (
    <FormField label={label} helper={helper} error={error} required={required}>
      <Input ref={ref} {...inputProps} />
    </FormField>
  );
});
TextField.displayName = 'TextField';
