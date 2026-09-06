import { ENGAGEMENT_CHANNELS, type EngagementChannel } from './engagement-vocab.js';

// COMM-C3 — provider-neutral evidence-capability registry (directive C3-4/R7/§7).
// It records, per CHANNEL, whether a real, queryable provider-neutral evidence
// producer/read exists at this baseline. It names NO provider (Zoom/Microsoft) —
// only the neutral channel and an availability boolean. This is the single fact
// that gates activation of a required channel (R7) and distinguishes
// "unavailable" from "no evidence" at read time (R9).
//
// Voice has the C2A provider-neutral evidence read; email has the C2B
// provider-neutral producer (Graph accepted send → CommunicationInteraction) +
// read (recorded_evidence), so both channels are now available. Flipping this
// flag does NOT publish or activate any Tenant Engagement Policy — it only lets
// an email-required policy pass the R7 activation guard once a real producer exists.

export interface ChannelEvidenceCapability {
  readonly channel: EngagementChannel;
  readonly available: boolean;
}

const CAPABILITY: Readonly<Record<EngagementChannel, boolean>> = Object.freeze({
  voice: true,
  email: true, // COMM-C2B — real email producer + provider-neutral read now exist.
});

/** Whether a real provider-neutral evidence producer/read exists for `channel`. */
export function isEvidenceChannelAvailable(channel: EngagementChannel): boolean {
  return CAPABILITY[channel];
}

/** The full capability snapshot (provider-neutral) — for admin/readiness surfaces. */
export function evidenceCapabilities(): ChannelEvidenceCapability[] {
  return ENGAGEMENT_CHANNELS.map((channel) => ({ channel, available: CAPABILITY[channel] }));
}
