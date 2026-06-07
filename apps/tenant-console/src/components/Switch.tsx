import * as RadixSwitch from '@radix-ui/react-switch';

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  id?: string;
  disabled?: boolean;
  'aria-label'?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  id,
  disabled = false,
  'aria-label': ariaLabel,
}: SwitchProps) {
  return (
    <RadixSwitch.Root
      className="tc-switch"
      checked={checked}
      onCheckedChange={onCheckedChange}
      id={id}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      <RadixSwitch.Thumb className="tc-switch__thumb" />
    </RadixSwitch.Root>
  );
}
