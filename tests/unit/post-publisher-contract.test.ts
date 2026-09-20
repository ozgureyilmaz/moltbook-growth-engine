import { describe, expect, it } from "vitest";
import { postActionIdFor, postBodyHash } from "../../src/domain/identifiers";
import { parsePublisherActionPayload } from "../../src/outbox/payload";
import { parseActionTransport, serializeActionTransport } from "../../src/outbox/transport";
import { buildMoltbookActionRequest, buildMoltbookPublicationReceipt, verifyMoltbookPublicationReceipt } from "../../src/publisher";
import type { PostActionPayload } from "../../src/orchestrator/contracts";

function postAction(): PostActionPayload {
  const title = "Greenland deal: what actually changes beyond the security headline?";
  const content = "The U.S., Denmark and Greenland have reached a new agreement. Marx: https://marx-tracker.example/r/ref";
  return {
    schemaVersion: "1.0",
    actionId: postActionIdFor("general", title, content),
    action: "POST",
    platform: "moltbook",
    target: { submolt: "general" },
    content: { title, content, type: "text" },
    decision: { opportunityScore: 1, evaluationScore: 1, confidence: 1 },
    experiment: { experimentId: "experiment-post-1", promptVersion: "manual/v1", modelVersion: "operator" },
    metadata: { createdAt: "2026-09-20T14:00:00.000Z", runId: "run-post-1" },
  };
}

describe("top-level post publisher contract", () => {
  it("round-trips a POST transport without inventing a source post id", () => {
    const action = postAction();
    const serialized = serializeActionTransport(action);
    const parsed = parseActionTransport(serialized, { mode: "production", allowedDomains: ["www.moltbook.com"] });

    expect(parsed).toEqual(action);
    expect(parsed.action).toBe("POST");
  });

  it("accepts a General post through the publisher action parser", () => {
    expect(parsePublisherActionPayload(postAction(), { mode: "production", allowedDomains: ["www.moltbook.com"] })).toMatchObject({
      action: "POST",
      target: { submolt: "general" },
    });
  });

  it("builds a hash-bound publisher request for the exact post body", () => {
    const action = postAction();
    const request = buildMoltbookActionRequest({
      action,
      grant: {
        schemaVersion: "1.0",
        grantId: "grant-post-1",
        publisherAccount: "MarxMolty",
        allowedActionIds: [action.actionId],
        maxActions: 1,
        issuedAt: "2026-09-20T13:00:00.000Z",
        expiresAt: "2026-09-20T15:00:00.000Z",
        purpose: "bounded-post-pilot",
        issuedBy: "operator",
      },
      publisherAccount: "MarxMolty",
      publisher: { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
      createdAt: "2026-09-20T14:01:00.000Z",
      now: new Date("2026-09-20T14:01:00.000Z"),
    });

    expect(request.action).toMatchObject({ action: "POST", target: { submolt: "general" } });
    expect(request.contentHash).toBe(postBodyHash(action.content.title, action.content.content));
    expect(request.targetHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("accepts a verified published-post receipt without inventing a target post", () => {
    const action = postAction();
    const request = buildMoltbookActionRequest({
      action,
      grant: {
        schemaVersion: "1.0",
        grantId: "grant-post-1",
        publisherAccount: "MarxMolty",
        allowedActionIds: [action.actionId],
        maxActions: 1,
        issuedAt: "2026-09-20T13:00:00.000Z",
        expiresAt: "2026-09-20T15:00:00.000Z",
        purpose: "bounded-post-pilot",
        issuedBy: "operator",
      },
      publisherAccount: "MarxMolty",
      publisher: { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
      createdAt: "2026-09-20T14:01:00.000Z",
      now: new Date("2026-09-20T14:01:00.000Z"),
    });
    const receipt = buildMoltbookPublicationReceipt({
      schemaVersion: "1.0",
      messageType: "MOLTBOOK_PUBLICATION_RECEIPT",
      receiptId: "receipt-post-1",
      requestId: request.requestId,
      requestHash: request.requestHash,
      actionId: request.actionId,
      actionHash: request.actionHash,
      idempotencyKey: request.idempotencyKey,
      contentHash: request.contentHash,
      bodyHash: request.bodyHash,
      targetHash: request.targetHash,
      status: "PUBLISHED",
      evidenceStatus: "verified",
      publisherAccount: "MarxMolty",
      providerPostId: "post-published-1",
      permalink: "https://www.moltbook.com/post/post-published-1",
      publishedAt: "2026-09-20T14:02:00.000Z",
      observedAt: "2026-09-20T14:02:01.000Z",
    });

    expect(verifyMoltbookPublicationReceipt(receipt, request).disposition).toBe("ACKNOWLEDGE");
  });
});
