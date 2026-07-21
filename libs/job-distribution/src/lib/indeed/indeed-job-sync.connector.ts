import { Injectable, Logger } from '@nestjs/common';

import type { ChannelPostingPayload } from '../channel-posting.types.js';
import { decimalStringToMinorUnits } from '../minor-units.js';

import {
  INDEED_GRAPHQL_BASE_DEFAULT,
  INDEED_GRAPHQL_BASE_ENV,
  RATE_PERIOD_TO_INDEED,
} from './indeed.constants.js';
import { IndeedTokenService } from './indeed-token.service.js';

// SRC-2 PR-3 (R6) — the Indeed Job Sync GraphQL connector. PLAIN fetch, typed
// query strings + typed response parsing; NO graphql client dependency, NO @aramo
// import (the lib stays buildable-import-free).
//
// RECON-1 verbatim: create AND update are ONE upsert mutation
// `jobsIngest.createSourcedJobPostings` keyed on (metadata.jobPostingId,
// metadata.jobSource.sourceName); it returns `sourcedPostingId` (→ our
// external_posting_id). Expiry is `jobsIngest.expireSourcedJobsBySourcedPostingId`
// keyed on that sourcedPostingId.
//
// FIDELITY NOTES (Gate-6, all PR-4 certification items — verified against the live
// schema, never improvised here per the DEV-D ruling's discipline):
//   • location: only `country` + `streetAddress` were verbatim-grounded, so PR-3
//     sends `location: { country }`; city/state/postal field names are cert-mapped.
//   • salary: only `minimumMinor` was grounded; advertised_pay_max + the exact
//     range field are cert items. `period` beyond "HOUR" is a best-effort map.
//   • taxonomyClassification (jobTypes/occupations) uses OPAQUE Indeed codes; we do
//     NOT invent a mapping — it is omitted at PR-3 (named PR-4 cert item).
//   • applyMethod nesting is derived from the `SourcedJobPostingIndeedApplyInput`
//     type name; exact placement is cert-verified.
// None of this affects CI: the integration suite drives a FAKED endpoint.

export interface IndeedEmployerId {
  type: string;
  id: string;
}

export interface IndeedApplyConfig {
  postUrl: string;
  apiToken: string;
}

export interface IndeedJobContext {
  // Our requisition UUID — the partner-supplied idempotency key (with sourceName).
  jobPostingId: string;
  // Per-tenant immutable client identifier (RECON-1: unique per client grouping).
  sourceName: string;
  companyName: string;
  employerIds: IndeedEmployerId[];
  // The Indeed Apply loop back into SRC-1's dark webhook. Omitted when the tenant
  // has no subdomain slug or the shared secret is unset.
  apply: IndeedApplyConfig | null;
}

export interface IndeedCreateResult {
  sourcedPostingId: string;
}

export class IndeedConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndeedConnectorError';
  }
}

const CREATE_MUTATION = `
mutation CreateSourcedJobPostings($input: CreateSourcedJobPostingsInput!) {
  jobsIngest {
    createSourcedJobPostings(input: $input) {
      results { jobPosting { sourcedPostingId } }
    }
  }
}`.trim();

const EXPIRE_MUTATION = `
mutation ExpireSourcedJobs($input: ExpireSourcedJobsBySourcedPostingIdInput!) {
  jobsIngest {
    expireSourcedJobsBySourcedPostingId(input: $input) {
      results { sourcedPostingId }
    }
  }
}`.trim();

@Injectable()
export class IndeedJobSyncConnector {
  private readonly logger = new Logger(IndeedJobSyncConnector.name);

  constructor(private readonly tokens: IndeedTokenService) {}

  private get graphqlUrl(): string {
    const configured = process.env[INDEED_GRAPHQL_BASE_ENV];
    return configured !== undefined && configured.length > 0
      ? configured
      : INDEED_GRAPHQL_BASE_DEFAULT;
  }

  // Upsert (create OR update — same mutation). Returns the sourcedPostingId Indeed
  // assigns on first create and echoes on every subsequent upsert of the same
  // (jobPostingId, sourceName).
  async createOrUpdate(
    payload: ChannelPostingPayload,
    ctx: IndeedJobContext,
  ): Promise<IndeedCreateResult> {
    const input = {
      jobPostings: [
        {
          body: this.buildBody(payload),
          metadata: this.buildMetadata(payload, ctx),
        },
      ],
    };
    const data = await this.execute(CREATE_MUTATION, { input });
    const sourcedPostingId = extractSourcedPostingId(data);
    if (sourcedPostingId === null) {
      throw new IndeedConnectorError(
        'createSourcedJobPostings returned no sourcedPostingId',
      );
    }
    return { sourcedPostingId };
  }

  async expire(sourcedPostingId: string): Promise<void> {
    await this.execute(EXPIRE_MUTATION, {
      input: { sourcedPostingIds: [sourcedPostingId] },
    });
  }

  private buildBody(payload: ChannelPostingPayload): Record<string, unknown> {
    const body: Record<string, unknown> = {
      title: payload.title,
      description: payload.description ?? '',
      descriptionFormatting: 'RICH_FORMATTING',
      // Only `country` is verbatim-grounded (fidelity note above).
      location: { country: payload.location.country },
    };
    const salary = buildSalary(payload.advertised_compensation);
    if (salary !== null) {
      body['salary'] = salary;
    }
    return body;
  }

  private buildMetadata(
    payload: ChannelPostingPayload,
    ctx: IndeedJobContext,
  ): Record<string, unknown> {
    const metadata: Record<string, unknown> = {
      jobSource: {
        companyName: ctx.companyName,
        sourceName: ctx.sourceName,
        sourceType: 'Employer',
        employerIds: ctx.employerIds,
      },
      jobPostingId: ctx.jobPostingId,
      datePublished: payload.posted_at,
    };
    if (ctx.apply !== null) {
      // Type name SourcedJobPostingIndeedApplyInput → `indeedApply` (cert-verified).
      metadata['indeedApply'] = {
        postUrl: ctx.apply.postUrl,
        apiToken: ctx.apply.apiToken,
      };
    }
    return metadata;
  }

  private async execute(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<unknown> {
    const token = await this.tokens.getAccessToken();
    let res: Response;
    try {
      res = await fetch(this.graphqlUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw new IndeedConnectorError(
        `Indeed GraphQL request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new IndeedConnectorError(`Indeed GraphQL HTTP ${res.status}`);
    }
    const json = (await res.json()) as {
      data?: unknown;
      errors?: Array<{ message?: string }>;
    };
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      throw new IndeedConnectorError(
        `Indeed GraphQL errors: ${json.errors.map((e) => e.message ?? 'unknown').join('; ')}`,
      );
    }
    return json.data;
  }
}

// salary from advertised comp: include only when a currency, a mappable period and
// a minimum are all present (an unmapped period → the whole salary is omitted
// rather than sent partial/guessed). minimumMinor via STRING arithmetic (DEV-D).
function buildSalary(
  comp: ChannelPostingPayload['advertised_compensation'],
): Record<string, unknown> | null {
  if (comp.currency === null || comp.min === null || comp.period === null) {
    return null;
  }
  const period = RATE_PERIOD_TO_INDEED[comp.period];
  if (period === undefined) {
    return null;
  }
  return {
    currency: comp.currency,
    period,
    minimumMinor: decimalStringToMinorUnits(comp.min),
  };
}

function extractSourcedPostingId(data: unknown): string | null {
  const results = (data as {
    jobsIngest?: {
      createSourcedJobPostings?: {
        results?: Array<{ jobPosting?: { sourcedPostingId?: unknown } }>;
      };
    };
  })?.jobsIngest?.createSourcedJobPostings?.results;
  const id = results?.[0]?.jobPosting?.sourcedPostingId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
