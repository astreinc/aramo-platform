import * as RadixRadioGroup from '@radix-ui/react-radio-group';
import type { ReactNode } from 'react';

export interface RadioOption<T extends string> {
  value: T;
  label: ReactNode;
}

interface RadioGroupProps<T extends string> {
  name: string;
  value: T;
  options: ReadonlyArray<RadioOption<T>>;
  onValueChange: (value: T) => void;
  disabled?: boolean;
}

export function RadioGroup<T extends string>({
  name,
  value,
  options,
  onValueChange,
  disabled = false,
}: RadioGroupProps<T>) {
  return (
    <RadixRadioGroup.Root
      className="tc-radio-group"
      name={name}
      value={value}
      onValueChange={(next) => onValueChange(next as T)}
      disabled={disabled}
    >
      {options.map((opt) => {
        const itemId = `${name}-${opt.value}`;
        return (
          <div key={opt.value} className="tc-radio-row">
            <RadixRadioGroup.Item
              className="tc-radio"
              value={opt.value}
              id={itemId}
            >
              <RadixRadioGroup.Indicator className="tc-radio__indicator" />
            </RadixRadioGroup.Item>
            <label htmlFor={itemId} className="tc-radio-row__label">
              {opt.label}
            </label>
          </div>
        );
      })}
    </RadixRadioGroup.Root>
  );
}
