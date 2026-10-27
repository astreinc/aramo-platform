// Process-wide "hosted mode is active" flag (M-A5 §3.3). While it is set, deep links and
// tapped pushes do not navigate (they would open workspace screens above the locked
// hosted screen); the hosted screen sets it on mount and clears it only after the host's
// device authentication (or a sign-out, which removes every workspace screen anyway).
let locked = false;

export function setHostedLocked(on: boolean): void {
  locked = on;
}

export function isHostedLocked(): boolean {
  return locked;
}
