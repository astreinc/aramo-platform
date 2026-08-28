# Aramo — Dead-Residue Ledger

Governed classification of catalog residue surfaced by a `REMOVED_SURFACE_SWEEP`.
Taxonomy (Architect 2026-08-28): `ACTIVE_REQUIRED` · `ACTIVE_RESERVED` ·
`HISTORICAL_REQUIRED` · `EXIT_HYG` · `REMOVE_NOW`. **Gate-5 requires
`REMOVE_NOW = EMPTY`.** `EXIT_HYG` items are real open questions handed to an
owning lane — they are NOT disguised as resolved and do NOT count against closure.

## HYG-1 (2026-08-28) — Repository Residue Reconciliation

### REMOVE_NOW — EMPTY
No live/product-contract residue remains for any surface this program retired.

### Removed (proven-dead, executed in HYG-2)
| Item | Class before removal | Evidence |
|---|---|---|
| `pipeline:remove` scope | dead orphan | 0 `@RequireScopes`; route + `PipelineRepository.delete` withdrawn at L2-B; only comments + fixtures referenced it |
| `pipeline:add-activity` scope | dead orphan | 0 `@RequireScopes`; no activity route (`activity:create` superseded it); only comments + fixtures |
| `submittal-policy:write` scope + the `SubmittalPolicyRepository` write cluster | dead orphan + dead code | 0 `@RequireScopes`; `setPolicy()`/`getInputs()`/`getPolicy()` had 0 callers; dead barrel export |
| `PRESIGNED_URL_EXPIRED` error code | dead code | 0 throw-sites; not a documented reserved code (contrast `REQUISITION_NO_OPENINGS`) |

### ACTIVE_RESERVED — retained, rationale in the active catalog (`scope.dto.ts`)
| Scope | Authority (why it exists now) |
|---|---|
| `auth:session:read` | baseline session-established marker; gate role superseded by consumer_type gating, retained pending the **F31** scope-registry design (M3-PR-9 Ruling 7) |
| `identity:user:read` | Lead-ratified auditor/compliance bundle (E2 §182); read surface deferred to the Reporting/Audit DDR |
| `identity:tenant:read` | same auditor/compliance bundle |
| `assignment:create` | Track4/T4-D ratified ContractAssignment authority class; no live handler yet |
| `assignment:update` | same T4-D authority; dormant, cited as the reserved verb in live `placement.controller.ts` |
| `examination:read` | examination-read gate reserved by the OpenAPI contract (`x-required-scope` on 5 routes; PR-A1a-2 §48); no live handler yet |

### EXIT_HYG — removed from hygiene scope; owning-lane ruling required
| Scope | Owner | Reason |
|---|---|---|
| `consent:read` | **Consent / Portal architecture** | live callable internal `ConsentController` surface (currently `JwtAuthGuard`-only); whether to retire the scope or wire it as the internal gate is an authorization-semantics ruling the owning lane must make — not a hygiene decision |
| `consent:write` | **Consent / Portal architecture** | same |

*These two have no runtime consumer today (0 `@RequireScopes`, 0 FE `hasScope`, no `/me` display, no policy/interceptor/OpenAPI/Pact use), so removing them would be behaviorally safe — but the closure guard forbids HYG deciding a live-surface authorization question. Held, not deleted; not counted under `REMOVE_NOW`.*
