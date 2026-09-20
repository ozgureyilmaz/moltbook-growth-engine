import { z } from "zod";
import {
  IdSchema,
  HttpUrlSchema,
  IsoDateSchema,
  MetadataSchema,
  NoActionReasonSchema,
  ScoreSchema,
  StrategyFamilySchema,
} from "./common";

export const ActionTargetSchema = z
  .object({
    postId: IdSchema,
    postUrl: HttpUrlSchema,
    submolt: z.string().trim().min(1).optional(),
    agentId: IdSchema.optional(),
    agentName: z.string().trim().min(1).optional(),
  })
  .strict();

export const CommentContentSchema = z
  .object({
    // Publishable comments must mention Marx, normally exactly once.
    comment: z
      .string()
      .trim()
      .min(1)
      .refine((value) => /\bmarx\b/i.test(value), "publishable comments must mention Marx"),
    strategyFamily: StrategyFamilySchema,
    hookFamily: z.string().trim().min(1),
  })
  .strict();

export const ActionDecisionSchema = z
  .object({
    opportunityScore: ScoreSchema,
    evaluationScore: ScoreSchema,
    confidence: ScoreSchema,
  })
  .strict();

export const ExperimentReferenceSchema = z
  .object({
    experimentId: IdSchema,
    promptVersion: z.string().trim().min(1),
    modelVersion: z.string().trim().min(1),
  })
  .strict();

export const CommentActionSchema = z
  .object({
    schemaVersion: z.string().trim().min(1),
    actionId: IdSchema,
    action: z.literal("COMMENT"),
    platform: z.literal("moltbook"),
    target: ActionTargetSchema,
    content: CommentContentSchema,
    decision: ActionDecisionSchema,
    experiment: ExperimentReferenceSchema,
    metadata: z
      .object({ createdAt: IsoDateSchema, runId: IdSchema })
      .and(MetadataSchema),
  })
  .strict();

export const PostActionSchema = z
  .object({
    schemaVersion: z.string().trim().min(1),
    actionId: IdSchema,
    action: z.literal("POST"),
    platform: z.literal("moltbook"),
    target: z.object({ submolt: z.string().trim().min(1) }).strict(),
    content: z.object({
      title: z.string().trim().min(1).max(300),
      content: z.string().trim().min(1).max(40000),
      type: z.literal("text"),
    }).strict(),
    decision: ActionDecisionSchema,
    experiment: ExperimentReferenceSchema,
    metadata: z
      .object({ createdAt: IsoDateSchema, runId: IdSchema })
      .and(MetadataSchema),
  })
  .strict();

export const NoActionSchema = z
  .object({
    schemaVersion: z.string().trim().min(1),
    actionId: IdSchema,
    action: z.literal("NO_ACTION"),
    reason: NoActionReasonSchema,
    target: ActionTargetSchema.optional(),
    metadata: z
      .object({ createdAt: IsoDateSchema, runId: IdSchema })
      .and(MetadataSchema),
  })
  .strict();

export const ActionSchema = z.discriminatedUnion("action", [CommentActionSchema, NoActionSchema]);

export type ActionTarget = z.infer<typeof ActionTargetSchema>;
export type CommentContent = z.infer<typeof CommentContentSchema>;
export type ActionDecision = z.infer<typeof ActionDecisionSchema>;
export type ExperimentReference = z.infer<typeof ExperimentReferenceSchema>;
export type CommentAction = z.infer<typeof CommentActionSchema>;
export type PostAction = z.infer<typeof PostActionSchema>;
export type NoAction = z.infer<typeof NoActionSchema>;
export type Action = z.infer<typeof ActionSchema>;
export const ActionPayloadSchema = CommentActionSchema;
export type ActionPayload = CommentAction;

export type ActionSecurityMode = "production" | "fixture" | "dry-run";

export type ActionSecurityOptions = {
  /** Production requires an allow-list; fixture/dry-run may use fixture hosts. */
  mode?: ActionSecurityMode;
  allowedDomains?: readonly string[];
  fixtureDomains?: readonly string[];
};

function normalizedDomain(value: string): string {
  const candidate = value.trim().toLowerCase().replace(/^\.+/u, "").replace(/\.$/u, "");
  if (!candidate) return "";
  try {
    return new URL(candidate.includes("://") ? candidate : `https://${candidate}`).hostname.toLowerCase();
  } catch {
    return candidate;
  }
}

function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function isLocalFixtureHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
}

/** Applies contextual URL policy after the structural ActionSchema parse. */
export function validateActionSecurity(value: unknown, options: ActionSecurityOptions = {}): { success: true; data: Action } | { success: false; error: Error } {
  const parsed = ActionSchema.safeParse(value);
  if (!parsed.success) return { success: false, error: parsed.error };
  const mode = options.mode ?? "production";
  const allowed = (options.allowedDomains ?? []).map(normalizedDomain).filter(Boolean);
  const fixtureDomains = (options.fixtureDomains ?? ["moltbook.local", "example.test"]).map(normalizedDomain).filter(Boolean);
  const targetUrl = parsed.data.target?.postUrl;
  if (!targetUrl) return { success: true, data: parsed.data };
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return { success: false, error: new Error("action target URL is invalid") };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { success: false, error: new Error("action target URL must use http or https") };
  }
  if (url.username || url.password) {
    return { success: false, error: new Error("action target URL must not contain credentials") };
  }
  if (mode !== "production" && (fixtureDomains.some((domain) => hostMatchesDomain(host, domain)) || isLocalFixtureHost(host))) {
    return { success: true, data: parsed.data };
  }
  if (isLocalFixtureHost(host)) {
    return { success: false, error: new Error("localhost and fixture hosts are not allowed for production actions") };
  }
  if (allowed.length === 0 || !allowed.some((domain) => hostMatchesDomain(host, domain))) {
    return { success: false, error: new Error(`action target domain is not approved: ${host}`) };
  }
  return { success: true, data: parsed.data };
}

export const NO_ACTION_REASONS = [
  "LOW_RELEVANCE",
  "WEAK_MARX_BRIDGE",
  "GENERIC_COMMENT",
  "THREAD_SATURATED",
  "DUPLICATE",
  "LOW_INFORMATION_VALUE",
  "PROMOTIONAL_ONLY",
  "UNSUPPORTED_CLAIM",
  "CONTEXT_MISSING",
  "PLATFORM_RESTRICTION",
  "PUBLISHING_RISK",
  "QUALITY_BELOW_THRESHOLD",
  "MODEL_FAILURE",
  "WORKER_FAILURE",
] as const;
