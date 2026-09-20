import { z } from "zod";

const RefSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/u, "tracker ref must be 22 base64url characters");
const TrackingUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "http:" || url.protocol === "https:";
}, "trackingUrl must use http or https");
const DestinationUrlSchema = z.string().url().refine((value) => new URL(value).protocol === "https:", "destinationUrl must use https");

const CreateResponseSchema = z.object({
  ref: RefSchema,
  trackingUrl: TrackingUrlSchema,
  destinationUrl: DestinationUrlSchema,
  status: z.enum(["pending", "active"]),
}).strict();

const FinalizeResponseSchema = z.object({
  ref: RefSchema,
  status: z.literal("active"),
  actionId: z.string().trim().min(1),
  experimentId: z.string().trim().min(1),
  commentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  publishedPostId: z.string().trim().min(1).optional(),
  publishedPostUrl: z.string().url().optional(),
}).strict();

const SummaryResponseSchema = z.object({
  ref: RefSchema,
  clicked: z.boolean(),
  totalRedirects: z.number().int().nonnegative(),
  firstClickedAt: z.string().nullable(),
  lastClickedAt: z.string().nullable(),
  status: z.enum(["pending", "active", "revoked"]),
}).strict();

const RevokeResponseSchema = z.object({
  ref: RefSchema,
  status: z.literal("revoked"),
}).strict();

type TrackerCreateRequestBase = {
  ref: string;
  preLinkIdentity: string;
  destinationUrl: string;
  platform: "moltbook";
  feedId: string;
  runId: string;
  opportunityId: string;
  candidateId: string;
  idempotencyKey: string;
};

export type TrackerCreateRequest = TrackerCreateRequestBase & ({
  contentType: "comment";
  sourcePostId: string;
  sourceUrl: string;
  targetSubmolt?: string;
} | {
  contentType: "post";
  targetSubmolt: string;
  sourcePostId?: never;
  sourceUrl?: never;
});

export type TrackerFinalizeRequest = {
  actionId: string;
  experimentId: string;
  commentHash?: string;
  contentHash?: string;
  publishedPostId?: string;
  publishedPostUrl?: string;
};

export type TrackerCreateResponse = z.infer<typeof CreateResponseSchema>;
export type TrackerFinalizeResponse = z.infer<typeof FinalizeResponseSchema>;
export type TrackerSummary = z.infer<typeof SummaryResponseSchema>;
export type TrackerRevokeResponse = z.infer<typeof RevokeResponseSchema>;

export type MarxTrackerClient = {
  createDistribution(input: TrackerCreateRequest): Promise<TrackerCreateResponse>;
  finalizeDistribution(ref: string, input: TrackerFinalizeRequest): Promise<TrackerFinalizeResponse>;
  getSummary(ref: string): Promise<TrackerSummary>;
  revokeDistribution(ref: string): Promise<TrackerRevokeResponse>;
};

export type MarxTrackerHttpClientOptions = {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBackoffMs?: number;
  fetcher?: typeof fetch;
};

export class TrackerHttpError extends Error {
  public constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
    public readonly retryable = false,
    public readonly ambiguous = false,
  ) {
    super(message);
    this.name = "TrackerHttpError";
  }
}

/** Authenticated HTTP adapter for the marx-tracker Worker. */
export class MarxTrackerHttpClient implements MarxTrackerClient {
  private readonly origin: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryBackoffMs: number;

  public constructor(private readonly options: MarxTrackerHttpClientOptions) {
    const parsed = new URL(options.baseUrl);
    if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
      throw new Error("tracker base URL must use HTTPS outside local development");
    }
    if (!options.token.trim()) throw new Error("tracker token must not be empty");
    this.origin = parsed.origin;
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxAttempts = options.maxAttempts ?? 2;
    this.retryBackoffMs = options.retryBackoffMs ?? 250;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) throw new Error("tracker maxAttempts must be a positive integer");
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error("tracker timeoutMs must be a positive integer");
  }

  public async createDistribution(input: TrackerCreateRequest): Promise<TrackerCreateResponse> {
    const response = await this.request("POST", "/v1/distributions", input, [200, 201]);
    const parsed = CreateResponseSchema.parse(response.body);
    if (parsed.destinationUrl !== input.destinationUrl) throw new TrackerHttpError("Tracker returned a different destination URL", response.status, "destination_mismatch", false, true);
    this.assertTrackingUrl(parsed.trackingUrl, parsed.ref);
    return parsed;
  }

  public async finalizeDistribution(ref: string, input: TrackerFinalizeRequest): Promise<TrackerFinalizeResponse> {
    if (!input.commentHash && !input.contentHash) throw new Error("tracker finalization requires commentHash or contentHash");
    const response = await this.request("PATCH", `/v1/distributions/${encodeURIComponent(RefSchema.parse(ref))}/finalize`, input, [200]);
    const parsed = FinalizeResponseSchema.parse(response.body);
    if (parsed.ref !== ref || parsed.actionId !== input.actionId || parsed.experimentId !== input.experimentId || parsed.commentHash !== input.commentHash) {
      throw new TrackerHttpError("Tracker finalization read-back does not match the requested identity", response.status, "finalization_mismatch", false, false);
    }
    return parsed;
  }

  public async getSummary(ref: string): Promise<TrackerSummary> {
    const response = await this.request("GET", `/v1/distributions/${encodeURIComponent(RefSchema.parse(ref))}/summary`, undefined, [200]);
    return SummaryResponseSchema.parse(response.body);
  }

  public async revokeDistribution(ref: string): Promise<TrackerRevokeResponse> {
    const response = await this.request("POST", `/v1/distributions/${encodeURIComponent(RefSchema.parse(ref))}/revoke`, undefined, [200]);
    return RevokeResponseSchema.parse(response.body);
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    expectedStatuses: readonly number[],
  ): Promise<{ body: unknown; status: number }> {
    let lastError: TrackerHttpError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetcher(`${this.origin}${path}`, {
          method,
          signal: controller.signal,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.options.token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const parsedBody = await parseJson(response);
        if (!expectedStatuses.includes(response.status)) {
          const errorBody = parsedBody && typeof parsedBody === "object" && "error" in parsedBody && typeof parsedBody.error === "string"
            ? parsedBody.error
            : `HTTP_${response.status}`;
          const retryable = response.status === 429 || response.status >= 500;
          lastError = new TrackerHttpError(`Tracker request failed: ${errorBody}`, response.status, errorBody, retryable, false);
          if (!retryable || attempt === this.maxAttempts) throw lastError;
          await backoff(this.retryBackoffMs, attempt);
          continue;
        }
        return { body: parsedBody, status: response.status };
      } catch (error) {
        if (error instanceof TrackerHttpError) {
          if (!error.retryable || attempt === this.maxAttempts) throw error;
          lastError = error;
          await backoff(this.retryBackoffMs, attempt);
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        lastError = new TrackerHttpError(`Tracker request outcome is ambiguous: ${message}`, undefined, "ambiguous_request", true, true);
        if (attempt === this.maxAttempts) throw lastError;
        await backoff(this.retryBackoffMs, attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new TrackerHttpError("Tracker request failed", undefined, "request_failed");
  }

  private assertTrackingUrl(value: string, ref: string): void {
    const parsed = new URL(value);
    if (parsed.origin !== this.origin || parsed.pathname !== `/r/${ref}` || parsed.search || parsed.hash) {
      throw new TrackerHttpError("Tracker returned an unexpected tracking URL", 200, "invalid_tracking_url", false, true);
    }
  }
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TrackerHttpError(`Tracker returned invalid JSON: ${message}`, response.status, "invalid_json", false, response.status >= 200 && response.status < 300);
  }
}

async function backoff(delayMs: number, attempt: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs * attempt));
}
