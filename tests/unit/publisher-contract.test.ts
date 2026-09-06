import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actionIdFor, commentHash } from "../../src/domain/identifiers";
import type { ActionPayload } from "../../src/orchestrator/contracts";
import { LocalOutbox } from "../../src/outbox";
import {
  buildMoltbookActionRequest,
  buildMoltbookPublicationReceipt,
  PublicationReceiptProcessor,
  PublisherHandoffStore,
  signAutonomousGrant,
  signMoltbookPublicationReceipt,
  verifyMoltbookPublicationReceipt,
  type AutonomousGrant,
  type MoltbookPublicationReceipt,
} from "../../src/publisher";

const temporaryPaths: string[] = [];
afterEach(async () => Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function action(): ActionPayload {
  const comment = "That provenance gap is useful: Marx could expose the counter-evidence before agents converge.";
  const strategyFamily = "provenance" as const;
  return {
    schemaVersion: "1.0",
    actionId: actionIdFor("post-1", comment, strategyFamily),
    action: "COMMENT",
    platform: "moltbook",
    target: { postId: "post-1", postUrl: "https://www.moltbook.com/post/post-1", submolt: "agents", agentId: "agent-1" },
    content: { comment, strategyFamily, hookFamily: "counter-evidence" },
    decision: { opportunityScore: 0.82, evaluationScore: 0.84, confidence: 0.8 },
    experiment: { experimentId: "experiment-1", promptVersion: "generator/v1", modelVersion: "gpt-5.6-luna" },
    metadata: { createdAt: "2026-08-27T12:00:00.000Z", runId: "run-1" },
  };
}

function grant(value = action()): AutonomousGrant {
  return {
    schemaVersion: "1.0",
    grantId: "grant-1",
    publisherAccount: "MarxMolty",
    allowedActionIds: [value.actionId],
    maxActions: 1,
    issuedAt: "2026-08-27T11:00:00.000Z",
    expiresAt: "2026-08-27T14:00:00.000Z",
    purpose: "bounded-pilot",
    issuedBy: "operator",
  };
}

function request() {
  const value = action();
  return buildMoltbookActionRequest({
    action: value,
    grant: grant(value),
    publisherAccount: "MarxMolty",
    publisher: { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
    createdAt: "2026-08-27T12:01:00.000Z",
    now: new Date("2026-08-27T12:01:00.000Z"),
  });
}

function receipt(overrides: Partial<MoltbookPublicationReceipt> = {}): MoltbookPublicationReceipt {
  const req = request();
  return buildMoltbookPublicationReceipt({
    schemaVersion: "1.0",
    messageType: "MOLTBOOK_PUBLICATION_RECEIPT",
    receiptId: "receipt-1",
    requestId: req.requestId,
    requestHash: req.requestHash,
    actionId: req.actionId,
    actionHash: req.actionHash,
    idempotencyKey: req.idempotencyKey,
    contentHash: req.contentHash,
    bodyHash: req.bodyHash,
    targetHash: req.targetHash,
    status: "PUBLISHED",
    evidenceStatus: "verified",
    publisherAccount: "MarxMolty",
    targetPostId: "post-1",
    providerCommentId: "comment-1",
    permalink: "https://www.moltbook.com/post/post-1#comment-comment-1",
    publishedAt: "2026-08-27T12:02:00.000Z",
    observedAt: "2026-08-27T12:02:01.000Z",
    ...overrides,
  });
}

describe("Hermes publisher boundary", () => {
  it("builds stable hash-bound requests for exact content, account, and grant", () => {
    const first = request();
    const second = request();
    expect(first).toEqual(second);
    expect(first.contentHash).toBe(commentHash(action().content.comment));
    expect(first.publisher).toEqual({ provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "xhigh" });
    expect(first.action).toMatchObject({ action_id: action().actionId, target: { post_id: "post-1" } });
  });

  it("requires and verifies an authenticated grant and publication receipt in production", () => {
    const secret = "publisher-contract-test-secret";
    const signedGrant = signAutonomousGrant(grant(), "contract-v1", secret);
    const signedRequest = buildMoltbookActionRequest({
      action: action(),
      grant: signedGrant,
      publisherAccount: "MarxMolty",
      publisher: { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
      createdAt: "2026-08-27T12:01:00.000Z",
      now: new Date("2026-08-27T12:01:00.000Z"),
    });
    const signedReceipt = signMoltbookPublicationReceipt({
      schemaVersion: "1.0",
      messageType: "MOLTBOOK_PUBLICATION_RECEIPT",
      receiptId: "receipt-signed",
      requestId: signedRequest.requestId,
      requestHash: signedRequest.requestHash,
      actionId: signedRequest.actionId,
      actionHash: signedRequest.actionHash,
      idempotencyKey: signedRequest.idempotencyKey,
      contentHash: signedRequest.contentHash,
      bodyHash: signedRequest.bodyHash,
      targetHash: signedRequest.targetHash,
      status: "PUBLISHED",
      evidenceStatus: "verified",
      publisherAccount: "MarxMolty",
      targetPostId: "post-1",
      providerCommentId: "comment-signed",
      permalink: "https://www.moltbook.com/post/post-1#comment-comment-signed",
      publishedAt: "2026-08-27T12:02:00.000Z",
      observedAt: "2026-08-27T12:02:01.000Z",
    }, "contract-v1", secret);
    expect(verifyMoltbookPublicationReceipt(signedReceipt, signedRequest, { contractSecret: secret, expectedKeyId: "contract-v1", requireSignature: true }).disposition).toBe("ACKNOWLEDGE");
    expect(() => verifyMoltbookPublicationReceipt(signedReceipt, request(), { contractSecret: secret, expectedKeyId: "contract-v1", requireSignature: true })).toThrow(/grant contract signature is required/u);
    expect(() => verifyMoltbookPublicationReceipt(receipt(), signedRequest, { contractSecret: secret, expectedKeyId: "contract-v1", requireSignature: true })).toThrow(/receipt contract signature is required/u);
  });

  it("validates the embedded action before creating a publisher request", () => {
    const invalid = { ...action(), target: { ...action().target, postUrl: "https://unapproved.example/post/post-1" } };
    expect(() => buildMoltbookActionRequest({
      action: invalid,
      grant: grant(invalid),
      publisherAccount: "MarxMolty",
      publisher: { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
      now: new Date("2026-08-27T12:01:00.000Z"),
    })).toThrow(/not approved/u);
  });

  it("rejects account, target, and hash mismatches before acknowledging", () => {
    expect(() => verifyMoltbookPublicationReceipt(receipt({ publisherAccount: "OtherMolty" }), request())).toThrow(/publisher account/u);
    expect(() => verifyMoltbookPublicationReceipt(receipt({ targetPostId: "post-2" }), request())).toThrow(/target post/u);
    expect(() => verifyMoltbookPublicationReceipt(receipt({ contentHash: "0".repeat(64) }), request())).toThrow(/action, target, or content hash/u);
  });

  it("acknowledges only a verified published receipt and persists its evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "moltbook-publisher-"));
    temporaryPaths.push(root);
    const outbox = new LocalOutbox(join(root, "outbox"), { mode: "production", allowedDomains: ["www.moltbook.com"], productionGate: async () => undefined });
    await outbox.enqueue(action());
    const savePublication = vi.fn();
    const result = await new PublicationReceiptProcessor(outbox, { savePublication }).process(request(), receipt());
    expect(result.disposition).toBe("ACKNOWLEDGE");
    expect(await outbox.getState(action().actionId)).toMatchObject({ status: "ACKNOWLEDGED" });
    expect(savePublication).toHaveBeenCalledWith(expect.objectContaining({ status: "published", actionId: action().actionId }));
    await expect(new PublicationReceiptProcessor(outbox, { savePublication }).process(request(), receipt())).resolves.toMatchObject({ disposition: "ACKNOWLEDGE" });
  });

  it("reconciles a verified publication after an earlier read-back quarantine", async () => {
    const root = await mkdtemp(join(tmpdir(), "moltbook-publisher-reconcile-"));
    temporaryPaths.push(root);
    const outbox = new LocalOutbox(join(root, "outbox"), { mode: "production", allowedDomains: ["www.moltbook.com"], productionGate: async () => undefined });
    await outbox.enqueue(action());
    await outbox.fail(action().actionId, "temporary read-back lag", { reconciliationRequired: true });
    const result = await new PublicationReceiptProcessor(outbox).process(request(), receipt({ receiptId: "receipt-reconciled" }));
    expect(result.disposition).toBe("ACKNOWLEDGE");
    expect(await outbox.getState(action().actionId)).toMatchObject({ status: "ACKNOWLEDGED" });
  });

  it("quarantines uncertain or verification-required results and blocks blind retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "moltbook-publisher-"));
    temporaryPaths.push(root);
    const outbox = new LocalOutbox(join(root, "outbox"), { mode: "production", allowedDomains: ["www.moltbook.com"], productionGate: async () => undefined });
    await outbox.enqueue(action());
    const uncertain = receipt({
      receiptId: "receipt-uncertain",
      status: "RECONCILIATION_REQUIRED",
      evidenceStatus: "unverified",
      providerCommentId: undefined,
      permalink: undefined,
      publishedAt: undefined,
      errorCode: "PROVIDER_RESULT_UNKNOWN",
    });
    const result = await new PublicationReceiptProcessor(outbox).process(request(), uncertain);
    expect(result.disposition).toBe("QUARANTINE");
    expect(await outbox.getState(action().actionId)).toMatchObject({ status: "FAILED", failureDetails: { reconciliationRequired: true } });
    await expect(outbox.retry(action().actionId)).resolves.toBe(false);
  });

  it.each(["FAILED", "VERIFICATION_REQUIRED"] as const)("keeps %s receipts terminal and auditable", async (status) => {
    const root = await mkdtemp(join(tmpdir(), "moltbook-publisher-"));
    temporaryPaths.push(root);
    const outbox = new LocalOutbox(join(root, "outbox"), { mode: "production", allowedDomains: ["www.moltbook.com"], productionGate: async () => undefined });
    await outbox.enqueue(action());
    const terminal = receipt({
      receiptId: `receipt-${status.toLowerCase()}`,
      status,
      evidenceStatus: "unverified",
      providerCommentId: undefined,
      permalink: undefined,
      publishedAt: undefined,
      errorCode: status === "FAILED" ? "PLATFORM_REJECTED" : "PLATFORM_VERIFICATION_REQUIRED",
    });
    const result = await new PublicationReceiptProcessor(outbox).process(request(), terminal);
    expect(result.disposition).toBe(status === "FAILED" ? "FAIL" : "QUARANTINE");
    expect(await outbox.getState(action().actionId)).toMatchObject({ status: "FAILED", failureDetails: { receiptStatus: status } });
  });

  it("writes an idempotent request file for the separate publisher", async () => {
    const root = await mkdtemp(join(tmpdir(), "moltbook-handoff-"));
    temporaryPaths.push(root);
    const store = new PublisherHandoffStore(root);
    const first = await store.writeRequest(request());
    const second = await store.writeRequest(request());
    expect(first.written).toBe(true);
    expect(second).toEqual({ written: false, path: first.path });
    expect(JSON.parse(await readFile(first.path, "utf8"))).toMatchObject({ messageType: "MOLTBOOK_ACTION_REQUEST" });
  });

  it("requires an explicit kill-switch gate before production enqueue", async () => {
    const root = await mkdtemp(join(tmpdir(), "moltbook-publisher-"));
    temporaryPaths.push(root);
    const outbox = new LocalOutbox(join(root, "outbox"), { mode: "production", allowedDomains: ["www.moltbook.com"] });
    await expect(outbox.enqueue(action())).rejects.toThrow(/kill-switch gate/u);
  });
});
