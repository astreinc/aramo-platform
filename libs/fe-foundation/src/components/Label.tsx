import * as RadixLabel from '@radix-ui/react-label';
import type { ComponentPropsWithoutRef } from 'react';

type LabelProps = ComponentPropsWithoutRef<typeof RadixLabel.Root>;

export function Label({ className, ...rest }: LabelProps) {
  const classes = ['tc-label', className].filter(Boolean).join(' ');
  return <RadixLabel.Root className={classes} {...rest} />;
}
