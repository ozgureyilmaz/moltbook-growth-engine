import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { actionIdFor } from "../../src/domain/identifiers";
import { buildMoltbookActionRequest, signAutonomousGrant, verifyMoltbookPublicationReceipt } from "../../src/publisher";
import type { ActionPayload } from "../../src/orchestrator/contracts";

describe("bundled Python publisher contract", () => {
  it("verifies a real engine request and returns an engine-verifiable signed receipt without HTTP", () => {
    const secret = "fixture-contract-not-a-real-secret";
    const now = new Date();
    const comment = "That provenance gap matters: Marx can host a discussion of the counter-evidence.";
    const action: ActionPayload = {
      schemaVersion: "1.0", action: "COMMENT", platform: "moltbook", actionId: actionIdFor("post-test", comment, "provenance"),
      target: { postId: "post-test", postUrl: "https://www.moltbook.com/post/post-test", submolt: "agents", agentId: "agent-test" },
      content: { comment, strategyFamily: "provenance", hookFamily: "counter-evidence" },
      decision: { opportunityScore: 0.82, evaluationScore: 0.84, confidence: 0.8 },
      experiment: { experimentId: "experiment-test", promptVersion: "generator/v1", modelVersion: "fixture" },
      metadata: { createdAt: now.toISOString(), runId: "run-test" },
    };
    const grant = signAutonomousGrant({ schemaVersion: "1.0", grantId: "grant-test", publisherAccount: "team_agent", allowedActionIds: [action.actionId], maxActions: 1, issuedAt: new Date(now.getTime() - 1000).toISOString(), expiresAt: new Date(now.getTime() + 60000).toISOString(), purpose: "fixture", issuedBy: "test" }, "contract-v1", secret);
    const request = buildMoltbookActionRequest({ action, grant, publisherAccount: "team_agent", publisher: { provider: "local-process", model: "bundled-python-v1", reasoningEffort: "none" }, now });
    const python = `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location("publisher",sys.argv[1])\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\ndata=json.load(sys.stdin)\nr=data["request"]\nm.verify_request(r,{"account":"team_agent","contract_key_id":"contract-v1","allowed_domains":["www.moltbook.com"]},m.now_utc(),data["secret"])\nreceipt=m.make_receipt(r,"RECONCILIATION_REQUIRED","FIXTURE","No HTTP attempted",None,None,"contract-v1",data["secret"])\nprint(json.dumps(receipt))`;
    const receipt = JSON.parse(execFileSync("python3", ["-c", python, resolve("integrations/moltbook-publisher/publish.py")], { input: JSON.stringify({ request, secret }), encoding: "utf8", timeout: 10000 }));
    const verified = verifyMoltbookPublicationReceipt(receipt, request, { contractSecret: secret, expectedKeyId: "contract-v1", requireSignature: true });
    expect(verified.receipt.status).toBe("RECONCILIATION_REQUIRED");
    expect(verified.disposition).not.toBe("ACKNOWLEDGE");
    expect(() => verifyMoltbookPublicationReceipt({ ...receipt, publisherAccount: "other" }, request, { contractSecret: secret, expectedKeyId: "contract-v1", requireSignature: true })).toThrow();
  });
});
