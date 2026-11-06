// M-A13 #12 (R-6) — later step labels are tappable; the screen decides how far they go.
import { fireEvent, render, screen } from '@testing-library/react-native';

import { Stepper } from '../Stepper';

describe('Stepper', () => {
  it('earlier and later labels report the tap; the current one does not', () => {
    const onStep = jest.fn();
    render(<Stepper step="recipients" onStep={onStep} />);
    fireEvent.press(screen.getByLabelText('Step 4 of 4, Review'));
    fireEvent.press(screen.getByLabelText('Step 1 of 4, Documents, done'));
    fireEvent.press(screen.getByLabelText('Step 2 of 4, Recipients'));
    expect(onStep.mock.calls).toEqual([['review'], ['documents']]);
  });
});
