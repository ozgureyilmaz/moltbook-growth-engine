import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import { actionIdFor, commentHash, deterministicId, sha256, stableStringify } from "../domain/identifiers";
import type { ActionPayload } from "../orchestrator/contracts";
import { parseActionPayload } from "../outbox/payload";
import { parseActionTransport, serializeActionTransport } from "../outbox/transport";
import type { Publication } from "../schemas";

export const AutonomousGrantSchema = z.object({
  schemaVersion: z.literal("1.0"),
  grantId: z.string().trim().min(1),
  publisherAccount: z.string().trim().min(1),
  allowedActionIds: z.array(z.string().trim().min(1)).min(1),
  maxActions: z.number().int().positive(),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  purpose: z.string().trim().min(1),
  issuedBy: z.string().trim().min(1),
  signatureKeyId: z.string().trim().min(1).optional(),
  signature: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict().superRefine((grant, context) => {
  if (new Set(grant.allowedActionIds).size !== grant.allowedActionIds.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "allowedActionIds must be unique" });
  if (grant.allowedActionIds.length > grant.maxActions) context.addIssue({ code: z.ZodIssueCode.custom, message: "allowedActionIds cannot exceed maxActions" });
  if (Date.parse(grant.expiresAt) <= Date.parse(grant.issuedAt)) context.addIssue({ code: z.ZodIssueCode.custom, message: "grant expiresAt must be after issuedAt" });
});

export const PublisherModelSchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoningEffort: z.string().trim().min(1),
}).strict();

export const MoltbookActionRequestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  messageType: z.literal("MOLTBOOK_ACTION_REQUEST"),
  requestId: z.string().trim().min(1),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  actionId: z.string().trim().min(1),
  actionHash: z.string().regex(/^[a-f0-9]{64}$/u),
  idempotencyKey: z.string().trim().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  bodyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  targetHash: z.string().regex(/^[a-f0-9]{64}$/u),
  platform: z.literal("moltbook"),
  publisherAccount: z.string().trim().min(1),
  publisher: PublisherModelSchema,
  grant: AutonomousGrantSchema,
  action: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime({ offset: true }),
}).strict().superRefine((request, context) => {
  try {
    const action = parseActionTransport(request.action, { mode: "production", allowedDomains: ["www.moltbook.com"] });
    if (action.action !== "COMMENT" || action.actionId !== request.actionId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "publisher request must contain the exact COMMENT action" });
    }
  } catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `publisher request action is invalid: ${error instanceof Error ? error.message : String(error)}` });
  }
});

export const PublicationReceiptStatusSchema = z.enum(["PUBLISHED", "FAILED", "VERIFICATION_REQUIRED", "RECONCILIATION_REQUIRED"]);

export const MoltbookPublicationReceiptSchema = z.object({
  schemaVersion: z.literal("1.0"),
  messageType: z.literal("MOLTBOOK_PUBLICATION_RECEIPT"),
  receiptId: z.string().trim().min(1),
  requestId: z.string().trim().min(1),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  actionId: z.string().trim().min(1),
  actionHash: z.string().regex(/^[a-f0-9]{64}$/u),
  idempotencyKey: z.string().trim().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  bodyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  targetHash: z.string().regex(/^[a-f0-9]{64}$/u),
  receiptHash: z.string().regex(/^[a-f0-9]{64}$/u),
  status: PublicationReceiptStatusSchema,
  evidenceStatus: z.enum(["verified", "unverified"]),
  publisherAccount: z.string().trim().min(1),
  targetPostId: z.string().trim().min(1),
  providerCommentId: z.string().trim().min(1).optional(),
  permalink: z.string().url().optional(),
  publishedAt: z.string().datetime({ offset: true }).optional(),
  observedAt: z.string().datetime({ offset: true }),
  errorCode: z.string().trim().min(1).optional(),
  errorMessage: z.string().trim().min(1).optional(),
  signatureKeyId: z.string().trim().min(1).optional(),
  signature: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((receipt, context) => {
  if (receipt.status === "PUBLISHED") {
    if (receipt.evidenceStatus !== "verified") context.addIssue({ code: z.ZodIssueCode.custom, message: "PUBLISHED receipt must have verified evidence" });
    if (!receipt.providerCommentId || !receipt.permalink || !receipt.publishedAt) context.addIssue({ code: z.ZodIssueCode.custom, message: "PUBLISHED receipt requires providerCommentId, permalink, and publishedAt" });
  }
  if (receipt.status !== "PUBLISHED" && !receipt.errorCode) context.addIssue({ code: z.ZodIssueCode.custom, message: "Non-published receipt requires errorCode" });
});

export type AutonomousGrant = z.infer<typeof AutonomousGrantSchema>;
export type PublisherModel = z.infer<typeof PublisherModelSchema>;
export type MoltbookActionRequest = z.infer<typeof MoltbookActionRequestSchema>;
export type MoltbookPublicationReceipt = z.infer<typeof MoltbookPublicationReceiptSchema>;

export type ContractVerificationOptions = {
  contractSecret?: string;
  expectedKeyId?: string;
  requireSignature?: boolean;
};

export function signContractValue(value: unknown, secret: string): string {
  if (!secret) throw new Error("contract signing secret is required");
  return createHmac("sha256", secret).update(stableStringify(value), "utf8").digest("hex");
}

export function signAutonomousGrant(grant: AutonomousGrant, keyId: string, secret: string): AutonomousGrant {
  const unsigned = unsignedContractValue(grant);
  return AutonomousGrantSchema.parse({ ...unsigned, signatureKeyId: keyId, signature: signContractValue(unsigned, secret) });
}

export function signMoltbookPublicationReceipt(
  receipt: Omit<MoltbookPublicationReceipt, "receiptHash" | "signatureKeyId" | "signature">,
  keyId: string,
  secret: string,
): MoltbookPublicationReceipt {
  const material = { ...receipt, signatureKeyId: keyId };
  return MoltbookPublicationReceiptSchema.parse({
    ...material,
    signature: signContractValue(receipt, secret),
    receiptHash: publicationReceiptHash({ ...material, signature: signContractValue(receipt, secret) }),
  });
}

export function verifyAutonomousGrant(value: unknown, options: ContractVerificationOptions = {}): AutonomousGrant {
  const grant = AutonomousGrantSchema.parse(value);
  verifyContractSignature(grant, options, "grant");
  return grant;
}

export function buildMoltbookActionRequest(input: {
  action: ActionPayload;
  grant: AutonomousGrant;
  publisherAccount: string;
  publisher: PublisherModel;
  createdAt?: string;
  now?: Date;
}): MoltbookActionRequest {
  const grant = AutonomousGrantSchema.parse(input.grant);
  const validatedAction = parseActionPayload(input.action, { mode: "production", allowedDomains: ["www.moltbook.com"] });
  if (validatedAction.action !== "COMMENT") throw new Error("Publisher request requires a COMMENT action");
  const now = input.now ?? new Date();
  if (Date.parse(grant.issuedAt) > now.getTime() || Date.parse(grant.expiresAt) <= now.getTime()) throw new Error("Autonomous grant is not currently valid");
  if (grant.publisherAccount !== input.publisherAccount) throw new Error("Autonomous grant is bound to a different publisher account");
  if (!grant.allowedActionIds.includes(validatedAction.actionId)) throw new Error("Autonomous grant does not authorize this action");
  const expectedActionId = actionIdFor(validatedAction.target.postId, validatedAction.content.comment, validatedAction.content.strategyFamily);
  if (expectedActionId !== validatedAction.actionId) throw new Error("Action ID is not canonical for the exact target and comment");
  const action = serializeActionTransport(validatedAction);
  const actionHash = sha256(stableStringify(action));
  const contentHash = commentHash(validatedAction.content.comment);
  const bodyHash = sha256(validatedAction.content.comment);
  const targetHash = sha256(stableStringify(action.target));
  const idempotencyKey = `moltbook:comment:v1:${validatedAction.actionId}`;
  const createdAt = input.createdAt ?? now.toISOString();
  const requestId = deterministicId("pubreq", { actionId: validatedAction.actionId, grantId: grant.grantId, actionHash });
  const material = {
    schemaVersion: "1.0" as const,
    messageType: "MOLTBOOK_ACTION_REQUEST" as const,
    requestId,
    actionId: validatedAction.actionId,
    actionHash,
    idempotencyKey,
    contentHash,
    bodyHash,
    targetHash,
    platform: "moltbook" as const,
    publisherAccount: input.publisherAccount,
    publisher: PublisherModelSchema.parse(input.publisher),
    grant,
    action,
    createdAt,
  };
  return MoltbookActionRequestSchema.parse({ ...material, requestHash: sha256(stableStringify(material)) });
}

export type ReceiptVerification = {
  receipt: MoltbookPublicationReceipt;
  disposition: "ACKNOWLEDGE" | "FAIL" | "QUARANTINE";
  publication: Publication;
};

export function verifyMoltbookPublicationReceipt(value: unknown, requestValue: unknown, options: ContractVerificationOptions = {}): ReceiptVerification {
  const request = MoltbookActionRequestSchema.parse(requestValue);
  const receipt = MoltbookPublicationReceiptSchema.parse(value);
  verifyAutonomousGrant(request.grant, options);
  verifyContractSignature(receipt, options, "receipt");
  const requestMaterial = { ...request } as Record<string, unknown>;
  delete requestMaterial.requestHash;
  if (sha256(stableStringify(requestMaterial)) !== request.requestHash) throw new Error("Publisher request hash is invalid");
  const parsedAction = parseActionTransport(request.action, { mode: "production", allowedDomains: ["www.moltbook.com"] });
  if (parsedAction.action === "NO_ACTION" || parsedAction.actionId !== request.actionId) throw new Error("Publisher request does not contain the exact COMMENT action");
  if (actionIdFor(parsedAction.target.postId, parsedAction.content.comment, parsedAction.content.strategyFamily) !== parsedAction.actionId) throw new Error("Publisher request action ID is not canonical");
  if (sha256(stableStringify(request.action)) !== request.actionHash) throw new Error("Publisher request action hash is invalid");
  if (commentHash(parsedAction.content.comment) !== request.contentHash || sha256(parsedAction.content.comment) !== request.bodyHash) throw new Error("Publisher request body hash is invalid");
  if (receipt.requestId !== request.requestId || receipt.requestHash !== request.requestHash) throw new Error("Receipt is not bound to the publisher request");
  if (receipt.actionId !== request.actionId || receipt.actionHash !== request.actionHash || receipt.idempotencyKey !== request.idempotencyKey || receipt.contentHash !== request.contentHash || receipt.bodyHash !== request.bodyHash || receipt.targetHash !== request.targetHash) throw new Error("Receipt action, target, or content hash does not match");
  if (receipt.publisherAccount !== request.publisherAccount || receipt.publisherAccount !== request.grant.publisherAccount) throw new Error("Receipt publisher account does not match its grant");
  const target = request.action.target as Record<string, unknown> | undefined;
  if (receipt.targetPostId !== target?.post_id) throw new Error("Receipt target post does not match the action target");
  if (sha256(stableStringify(target)) !== request.targetHash) throw new Error("Publisher request target hash is invalid");
  if (receipt.receiptHash !== sha256(stableStringify({ ...receipt, receiptHash: undefined }))) throw new Error("Publication receipt hash is invalid");
  if (receipt.status === "PUBLISHED") assertOfficialPermalink(receipt.permalink!);
  const disposition = receipt.status === "PUBLISHED" ? "ACKNOWLEDGE" : receipt.status === "FAILED" ? "FAIL" : "QUARANTINE";
  const publication: Publication = {
    publicationId: receipt.receiptId,
    actionId: receipt.actionId,
    experimentId: (request.action.experiment as Record<string, unknown> | undefined)?.experiment_id as string | undefined,
    status: receipt.status === "PUBLISHED" ? "published" : "failed",
    attemptedAt: request.createdAt,
    ...(receipt.status === "PUBLISHED" ? { acknowledgedAt: receipt.publishedAt } : { errorMessage: receipt.errorMessage ?? receipt.errorCode }),
    metadata: {
      receiptStatus: receipt.status,
      evidenceStatus: receipt.evidenceStatus,
      requestId: receipt.requestId,
      requestHash: receipt.requestHash,
      actionHash: receipt.actionHash,
      idempotencyKey: receipt.idempotencyKey,
      contentHash: receipt.contentHash,
      bodyHash: receipt.bodyHash,
      targetHash: receipt.targetHash,
      publisherAccount: receipt.publisherAccount,
      targetPostId: receipt.targetPostId,
      providerCommentId: receipt.providerCommentId,
      permalink: receipt.permalink,
      observedAt: receipt.observedAt,
      errorCode: receipt.errorCode,
    },
  };
  return { receipt, disposition, publication };
}

export function publicationReceiptHash(value: Omit<MoltbookPublicationReceipt, "receiptHash">): string {
  return sha256(stableStringify(value));
}

export function buildMoltbookPublicationReceipt(value: Omit<MoltbookPublicationReceipt, "receiptHash">): MoltbookPublicationReceipt {
  return MoltbookPublicationReceiptSchema.parse({ ...value, receiptHash: publicationReceiptHash(value) });
}

function unsignedContractValue(value: Record<string, unknown>): Record<string, unknown> {
  const unsigned = { ...value };
  delete unsigned.signature;
  delete unsigned.signatureKeyId;
  delete unsigned.receiptHash;
  return unsigned;
}

function verifyContractSignature(value: Record<string, unknown>, options: ContractVerificationOptions, label: string): void {
  const signatureRequired = options.requireSignature === true;
  if (!value.signature || !value.signatureKeyId) {
    if (signatureRequired) throw new Error(`${label} contract signature is required`);
    return;
  }
  if (!options.contractSecret) throw new Error(`${label} contract secret is required to verify its signature`);
  if (options.expectedKeyId && value.signatureKeyId !== options.expectedKeyId) throw new Error(`${label} contract signature key ID is not approved`);
  const expected = signContractValue(unsignedContractValue(value), options.contractSecret);
  const actualBuffer = Buffer.from(String(value.signature), "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) throw new Error(`${label} contract signature is invalid`);
}

function assertOfficialPermalink(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.moltbook.com" || url.username || url.password) throw new Error("Published permalink is not an official Moltbook URL");
}
