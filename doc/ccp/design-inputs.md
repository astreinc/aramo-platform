# CCP design inputs (pinned per slice under Program Build Directive §6.2 and PLATFORM-UX-1 Amendment A1-5)

## CCP-UI v1.0 (Claude Design release, frozen 2026-10-24)
**Location:** OneDrive `Aramo/design/Platform-Admin-prototype/ccp/CCP-UI-v1_0/`.

`MANIFEST.sha256` was verified on disk on 2026-10-24 (5/5 OK):

| SHA-256 | File |
|---|---|
| `276ac8192e9f39adaf3230904b918852b59200e6e35c0b1933d42ad90ef198a2` | `Commercial Control Plane v1.0.dc.html` |
| `313fe1e1b67115688862921d4b273b1be07be6445b7d9dfa021d517a62e7b3df` | `ccp-data.js` (prototype data only, never shipped) |
| `8fe7df74405f3c55f49b7249c74ea1397e65d07dea2b1bd3b4a489bec2e28cbe` | `support.js` (identical to the PLATFORM-UX-1 pin) |
| `385e629f5b6453892cff55a955dd1ab671d655396ccb39df6b3a477e78b5049b` | `handoff/Commercial Control Plane - Claude Code handoff v1.0.md` |
| `721f7122196dd21e13bf51e6033c4c96c0152f183f5352ffcaf4d4a7d0fec01c` | `handoff/Commercial Control Plane - design amendments log v1.0.md` (empty at release) |

The PLATFORM-UX-1 pinned files were re-verified as byte-unchanged on 2026-10-24.

Each Phase B slice (B1–B6, plus the UI parts of C3, C4, C6, C7 and D1–D3) copies these hashes into its pre-execution record before its first commit. Later design changes enter only as numbered amendments in the amendments log, or as a new release with a new manifest.

## Resolutions of the release's two mapping gaps (lead, within the Program Build Directive schedule)
| Gap | Resolution | Basis |
|---|---|---|
| The policy screen has no UI slice | **B5**, because policy versions, approval chains and the commercial audit form one governance surface. The backend comes from A2 (policy versions) and A3 (activation as a change request). | PBD §5: B5 covers commercial governance (role management and the audit explorer); policy activation is an A3 change request |
| Contract evidence has no backend slice | **B4** owns it. B4's schedule row is "Enterprise contracts: backend `Contract` + `ContractAmendment` (commitment, negotiated terms, evidence) **and** UI". A6 applies the subscription a contract governs; it does not store contract terms. | PBD §5, B4 row |

## Open design questions (handoff §8)
| Question | Owner | Must be decided before |
|---|---|---|
| Q5 | **Architect** | A3 (NC-4/NC-5 context) |
| Q1 (policy activation chain) | **PO** | A3 |
| Q2 (non-privileged role changes need an owner) | **PO** | A9 |
| Q7 (chain for out-of-limit extension) | **PO** | A8 |
| Q8 (90-day window) | **Resolved:** rolling 90 days (PO, 2026-10-24) | — |
| Q14 (one open request per tenant × product) | **PO** | A3 |
| Q9 (bulk move of grandfathered tenants), Q10 (clone an expired request) | **PO** | B2 / B1; may be deferred |
