# CCP decision register (recorded rulings required by the Program Build Directive schedules)

| ID | Decision | Ruling | By / date | Governs |
|---|---|---|---|---|
| A2-B | Policy boundary semantics | Inclusive: discount ≥ 20% and credit ≥ $500 escalate; an extension ≤ 14 days is in-limit. Rolling 90-day frequency window. 30-day cumulative cap over rolling 12 months. 72 h expiry; expired at exactly 72 h. | PO, 2026-10-24 | CCP-A2, A8 |
| Q1 | Chain for policy activation (and rollback) | **Finance → Owner** | PO, 2026-10-24 | CCP-A3 |
| Q14 | Open requests per tenant × product | **One open request per tenant × product** | PO, 2026-10-24 | CCP-A3 |
| Q7 | Chain for an out-of-limit support extension | **Finance** (below-threshold chain) | PO, 2026-10-24 | CCP-A8 |
| Q2 | Role changes that are not owner or finance | **Need a distinct platform_owner** | PO, 2026-10-24 | CCP-A9 |
| Q5 / NC-4 / NC-5 | In-flight approvals when a role is revoked or the policy changes | **A signature stays valid. The request keeps its snapshotted policy version and chain. Eligibility and chain fulfillability are re-checked at APPLY time; apply is refused if the chain is no longer satisfiable by currently eligible distinct humans.** | PO, 2026-10-24 (Architect-owned item, ruled by the PO; flagged for Architect ratification at the program acceptance review) | CCP-A3, A6 |
| TD-A1-11 | The two "superseded" scope mappings in the `scope.dto.ts` deferral comment | **Confirmed as written** | PO, 2026-10-24 (Architect-owned; flagged for ratification) | CCP-A1 |
| TD-A1-12 | The stale "(super_admin only)" text on `platform:tenant:read` | **Fix it.** The seed description now names super_admin and the six commercial roles (console entry, A0-C5; CCP-FU-1). This is seed text only: existing databases keep the old description, because the seed upsert never updates an existing row. The A1 regression fingerprint records this deliberate change. | PO, 2026-10-24 (Architect-owned; flagged for ratification) | CCP-A1 |
| B5-P | UI slice for the policy screen | B5 | Lead, 2026-10-24 (within the PBD schedule) | CCP-B5 |
| B4-C | Backend owner for contract evidence | B4 (PBD B4 row) | Lead, 2026-10-24 | CCP-B4 |
| TD-A2-1 | Exact-instant edge of the rolling windows | **Half-open:** a period that has fully elapsed at `now` no longer counts. A prior extension exactly 90 days old does not block a new one; an extension exactly 365 days old leaves the 30-day cap; grace ends at exactly 7 days. This matches the 72 h expiry rule and the existing grace check. | PO, 2026-10-25 | CCP-A2, A8 |
| TD-A2-2 | "Above" (Charter §7) vs ≥ | **≥ (inclusive)**, per the PO-confirmed boundary semantics (Charter §14 item 2 delegates this to the PO) | PO, 2026-10-24; recorded for the Architect | CCP-A2 |
| TD-A2-3 | Credit in a currency other than USD | **Escalates** (`CURRENCY_NOT_COVERED`), never converted | Executor choice (fail-closed); recorded for PO/Architect | CCP-A2 |
