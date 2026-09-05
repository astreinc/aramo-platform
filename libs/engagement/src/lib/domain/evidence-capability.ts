import { ENGAGEMENT_CHANNELS, type EngagementChannel } from './engagement-vocab.js';

// COMM-C3 — provider-neutral evidence-capability registry (directive C3-4/R7/§7).
// It records, per CHANNEL, whether a real, queryable provider-neutral evidence
// producer/read exists at this baseline. It names NO provider (Zoom/Microsoft) —
// only the neutral channel and an availability boolean. This is the single fact
// that gates activation of a required channel (R7) and distinguishes
// "unavailable" from "no evidence" at read time (R9).
//
// At the locked baseline: voice has the C2A provider-neutral evidence read;
// email has a domain channel + association substrate but NO producer/read yet.

export interface ChannelEvidenceCapability {
  readonly channel: EngagementChannel;
  readonly available: boolean;
}

const CAPABILITY: Readonly<Record<EngagementChannel, boolean>> = Object.freeze({
  voice: true,
  email: false,
});

/** Whether a real provider-neutral evidence producer/read exists for `channel`. */
export function isEvidenceChannelAvailable(channel: EngagementChannel): boolean {
  return CAPABILITY[channel];
}

/** The full capability snapshot (provider-neutral) — for admin/readiness surfaces. */
export function evidenceCapabilities(): ChannelEvidenceCapability[] {
  return ENGAGEMENT_CHANNELS.map((channel) => ({ channel, available: CAPABILITY[channel] }));
}
