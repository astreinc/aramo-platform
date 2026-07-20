# Aramo Enterprise Context — v2.1

**Status:** Recon-grounded. Solid = implemented, verified against `main` @ `77b9fbf` (2026-07-20, Lead recon + Code verification pass A1–A6 / B1–B6 / C1–C2). Dashed = target-state, not built.

**Supersedes:** v2.0 (refuted on the sourcing flow: ADR-0019 un-ratified, no arrival writer exists).

**Corrections encoded in this version:**
1. Job-board arrivals flow via the sourcing sibling service into the `sourced_talent` staging schema — never JobBoards → Core API. The sourcing service and its write path are TARGET-STATE (dashed): nothing writes arrivals today.
2. Core API ↔ staging is split: the reader exists (admit-arrivals, TR-2b login-time re-link, solid); resolve-and-promote is fix-slice-2, not built (dashed).
3. Portal API edge is `/v1/portal/*` ONLY (Caddy-scoped; no general `/v1` from the portal host).
4. Core API remains THE HEART — ATS + Pipeline modular monolith with in-process BullMQ workers; no separate worker platform node (ADR-0017: extract only when forced).
5. Platform console talks to platform-admin (`/platform/*`), never Core API — the admin host has no `/v1` route (R14).
6. Secrets: AWS Secrets Manager is the primary key path; a documented box-only env fallback exists for the AI provider key (Single-Box Directive 2b).
7. PartnerSSO stays dashed; the fail-closed trusted-IdP verifier mechanism exists in auth-core, but no partner IdP is wired.

```mermaid
flowchart LR

    subgraph LEGEND["Legend"]
        L1["Implemented (verified on main @ 77b9fbf)"]
        L2["Target-state (planned)"]:::planned
    end

    subgraph USERS["Users and Stakeholders"]
        Recruiter["Recruiter / Sourcer"]
        Manager["Recruiting Manager"]
        TenantAdmin["Tenant Administrator"]
        Talent["Talent"]
        PlatformOps["Aramo Platform Operator"]
        HiringManager["Hiring Manager"]:::planned
        SaaSOwner["Aramo SaaS Owner<br/>(distinct persona)"]:::planned
        IntegrationAdmin["Partner Integration Administrator"]:::planned
    end

    subgraph ARAMO["Aramo Multi-Tenant Talent Platform"]
        PublicSite["Public Product Website<br/>aramo.ai"]:::planned
        ATSWeb["Tenant ATS Web Application<br/>&lt;slug&gt;.aramo.ai — wildcard, on-demand TLS"]
        TalentPortal["Talent Portal<br/>candidate.aramo.ai — passwordless magic-link"]
        PlatformConsole["Platform Operations Console<br/>admin.aramo.ai (platform-web SPA)"]
        OwnerConsole["SaaS Owner Console<br/>Plans, Subscriptions, Billing"]:::planned
        CoreAPI["Aramo Core API — THE HEART<br/>ATS + Pipeline modular monolith<br/>incl. in-process BullMQ workers (Redis)"]
        PlatformAdmin["Platform Admin API<br/>/platform/* only — no /v1 route (R14)"]
        AuthService["Aramo Authentication Service<br/>Identity Broker, Sessions, JWKS"]
        Staging["sourced_talent staging schema<br/>L1 table + repository shipped (Fix-Slice-1)<br/>no writer yet"]
    end

    SourcingService["Sourcing Service<br/>(sibling — ADR-0019 UN-RATIFIED,<br/>no writer exists today)"]:::planned

    subgraph PARTNER_SYSTEMS["Partner Systems"]
        JobBoards["Job Boards and Sourcing Channels"]:::planned
        ExternalATS["External ATS"]:::planned
        VMS["Vendor Management Systems<br/>Fieldglass, Beeline, Coupa, Oracle"]:::planned
        HRIS["HRIS / HCM Systems"]:::planned
        PartnerSSO["Partner Identity Provider<br/>per-partner OIDC / SAML"]:::planned
        PartnerBI["Partner Reporting / BI Platforms"]:::planned
    end

    subgraph ENTERPRISE_SERVICES["Cloud and Enterprise Services"]
        Cognito["Amazon Cognito<br/>tenant pool + platform pool"]
        Email["Email Delivery — SES"]
        ObjectStorage["Object / Resume Storage — S3"]
        Secrets["AWS Secrets Manager<br/>(AI provider key; documented<br/>box-only env fallback, Directive 2b)"]
        KMS["KMS / HSM<br/>identity pepper custody"]:::planned
        Observability["Monitoring, Logging and Alerting"]:::planned
    end

    Recruiter --> ATSWeb
    Manager --> ATSWeb
    TenantAdmin --> ATSWeb
    Talent --> TalentPortal
    PlatformOps --> PlatformConsole

    HiringManager -.-> ATSWeb
    SaaSOwner -.-> OwnerConsole
    IntegrationAdmin -.-> PlatformConsole
    Recruiter -. Product discovery .-> PublicSite
    TenantAdmin -. Subscription and onboarding .-> PublicSite

    ATSWeb -->|"/v1/*"| CoreAPI
    TalentPortal -->|"/v1/portal/* ONLY<br/>(no general /v1 from portal host)"| CoreAPI
    PlatformConsole -->|"/platform/*"| PlatformAdmin

    ATSWeb -->|"/auth/*"| AuthService
    TalentPortal -->|"/auth/*"| AuthService
    PlatformConsole -->|"/auth/*"| AuthService

    OwnerConsole -.-> PlatformAdmin
    OwnerConsole -.-> AuthService

    JobBoards -.-> SourcingService
    SourcingService -.->|"immutable arrival writes<br/>(target: recordArrival)"| Staging
    CoreAPI -->|"reads (admit-arrivals,<br/>TR-2b login re-link)"| Staging
    CoreAPI -.->|"resolve & promote<br/>(fix-slice-2, not built)"| Staging

    ExternalATS <-.->|"versioned connector contracts"| CoreAPI
    VMS <-.-> CoreAPI
    HRIS <-.-> CoreAPI
    CoreAPI -.-> PartnerBI
    PartnerSSO <-.->|"trusted-IdP verifier exists<br/>(fail-closed); no partner IdP wired"| AuthService

    AuthService <--> Cognito
    PlatformAdmin -->|"AdminCreateUser invites<br/>(both pools)"| Cognito

    CoreAPI --> Email
    AuthService -->|"portal magic-link mail"| Email

    CoreAPI <--> ObjectStorage
    CoreAPI -->|"AI provider key fetch"| Secrets

    CoreAPI -.->|"pepper custody migration"| KMS
    AuthService -.-> KMS
    CoreAPI -.-> Observability
    AuthService -.-> Observability
    PlatformAdmin -.-> Observability
    ATSWeb -.-> Observability

    classDef planned stroke-dasharray: 6 4, fill:#f9f9f9, color:#666
```

## Verification provenance

Solid nodes/edges were verified by direct reads of `docker-compose.prod.yml`, `deploy/caddy/Caddyfile`, `.env.prod.example`, and the implementing modules (recon pass items B1–B5), plus exhaustive ripgrep negative scans (A1–A6) and a sibling-repo sweep (C1–C2). The v2.0 → v2.1 delta is the sourcing flow (C1/C2: no writer, ADR-0019 un-ratified) and the Secrets env-fallback nuance (B6).

Amendments to this document follow standard directive discipline: recon before authoring, Lead ruling, PO filing to OneDrive canonical.
