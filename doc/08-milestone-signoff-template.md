# Aramo Milestone Sign-Off — M\<N\>

**Milestone:** M\<N\> — \<name\>
**Closure date:** YYYY-MM-DD
**Signed by:** \<engineering Lead/Architect name or session identifier\>
**Ratified by (PO):** [signature block]

Per Plan v1.2 §6 DoD criterion #7 ("Refusal layer integrity verified
explicitly — Lead Engineer signs off on refusal preservation"). This
template is the per-milestone substrate-readable record that satisfies
that criterion. Instantiate it as
`doc/milestone-signoffs/M<N>-refusal-signoff.md` at milestone closure.

The Policy 1 allowlist (PR-M0R-2 Amendment v1.0 §4.2, PO-ratified
2026-05-15) covers `doc/milestone-signoffs/*.md`, so legitimate Charter
quotations in this document are permitted by `verify:vocabulary`.

## §6 DoD Status

| Criterion | Status | Evidence |
|---|---|---|
| #1 APIs implemented per OpenAPI specification | PASS / PARTIAL / FAIL | \<cite file paths or substrate\> |
| #2 OpenAPI valid (swagger-cli + redocly lint) | PASS / PARTIAL / FAIL | \<cite command output\> |
| #3 Pact consumer tests exist for every endpoint added | PASS / PARTIAL / FAIL | \<cite consumer test files + test count\> |
| #4 Provider verification passes against Aramo Core test environment | PASS / PARTIAL / FAIL | \<cite pact:provider run + interaction count\> |
| #5 Refusal scripts pass (verify-portal-refusal.ts, verify-ats-refusal.ts, others as applicable) | PASS / PARTIAL / FAIL | \<cite CI gate names + exit-0 evidence\> |
| #6 CI blocks invalid deployments (deployment-gate.yml enforcing all checks) | PASS / PARTIAL / FAIL | \<cite ci.yml deployment-gate aggregator or deployment-gate.yml\> |
| #7 Refusal layer integrity verified explicitly (Lead Engineer signs off on refusal preservation) | PASS / PARTIAL / FAIL | \<this document itself; PO ratification block below\> |

## Refusal Layer Integrity

The 13 Charter v1.0 refusal commitments are enumerated below. For each,
this section records: (a) whether the refusal is at risk in this
milestone's scope, (b) for at-risk refusals, the specific enforcement
mechanism (schema constraint at `openapi/*.yaml` file:line / API
absence / CI script name / code path with file:line), and (c) substrate
evidence (command output, file path, test name, or grep result)
confirming the enforcement is active.

The refusal text below is **verbatim** from Charter v1.0 §8 at canonical
OneDrive location. Refusal numbering follows the program's R1–R13
linear convention.

### Refusal R1 — [verbatim Charter R1 text]
- At risk in M\<N\>? Yes / No
- Enforcement mechanism: \<schema constraint at openapi/\*.yaml file:line / API absence / CI script name / code path with file:line\>
- Substrate evidence: \<command output, file path, test name, or grep result\>

### Refusal R2 — [verbatim Charter R2 text]
- At risk in M\<N\>? Yes / No
- Enforcement mechanism: \<...\>
- Substrate evidence: \<...\>

### Refusal R3 — [verbatim Charter R3 text]
- At risk in M\<N\>? Yes / No
- Enforcement mechanism: \<...\>
- Substrate evidence: \<...\>

### Refusal R4 — [verbatim Charter R4 text]
- At risk in M\<N\>? Yes / No
- Enforcement mechanism: \<...\>
- Substrate evidence: \<...\>

### Refusal R5 — [verbatim Charter R5 text]
- At risk in M\<N\>? Yes / No
- Enforcement mechanism: \<...\>
- Substrate evidence: \<...\>

### Refusal R6 — [verbatim Charter R6 text]
- At risk in M\<N\>? Yes / No
- Enforcement mechanism: \<...\>
- Substrate evidence: \<...\>

### Refusal R7 — [verbatim Charter R7 text]
- At risk in M\<N\>? Yes / No
- Enforcement mechanism: \<...\>
- Substrate evidence: \<...\>

### Refusal R8 — [verbatim Charter R8 text]
- At risk in M\<N\>? Yes / No
- Enforcement mechanism: \<...\>
- Substrate evidence: \<...\>

### Refusal R9 — [verbatim Charter R9 text]
- At risk in M\<N\>? Yes / No
- Enforcement mechanism: \<...\>
- Substrate evidence: \<...\>

### Refusal R10 — [verbatim Charter R10 text]
- At risk in M\<N\>? Yes / No
- Enforcement mechanism: \<...\>
- Substrate evidence: \<...\>

### Refusal R11 — [verbatim Charter R11 text]
- At risk in M\<N\>? Yes / No
- Enforcement mechanism: \<...\>
- Substrate evidence: \<...\>

### Refusal R12 — [verbatim Charter R12 text]
- At risk in M\<N\>? Yes / No
- Enforcement mechanism: \<...\>
- Substrate evidence: \<...\>

### Refusal R13 — [verbatim Charter R13 text]
- At risk in M\<N\>? Yes / No
- Enforcement mechanism: \<...\>
- Substrate evidence: \<...\>

## Outstanding Items

Items deferred to subsequent milestones, with explicit M\<N+x\> hooks:

- \<Deferred item\>: target milestone, rationale

## Sign-off

I, \<engineering Lead/Architect\>, sign off on the refusal layer
integrity for M\<N\> per Plan v1.2 §6 DoD criterion #7. All 13 Charter
refusals have been evaluated against the milestone's scope; at-risk
refusals have substrate-verified enforcement mechanisms; not-at-risk
refusals have explicit rationale.

[Signature block]
[Date]

## PO Ratification

I, \<PO name\>, ratify M\<N\> closure per the operating-rule
recalibration of 2026-05-15 (milestone-closure-is-PO-territory). The
DoD status table reflects substrate truth; the refusal layer integrity
section is complete and substrate-anchored.

[Signature block]
[Date]
