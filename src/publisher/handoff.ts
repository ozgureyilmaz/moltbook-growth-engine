import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PersistenceLike } from "../orchestrator/contracts";
import { LocalOutbox } from "../outbox";
import { MoltbookActionRequestSchema, MoltbookPublicationReceiptSchema, verifyMoltbookPublicationReceipt, type ContractVerificationOptions, type MoltbookActionRequest, type MoltbookPublicationReceipt } from "./contracts";

export class PublisherHandoffStore {
  private readonly requestDirectory: string;
  private readonly receiptDirectory: string;

  public constructor(root = "outbox/handoff") {
    this.requestDirectory = join(root, "requests");
    this.receiptDirectory = join(root, "receipts");
  }

  public async initialize(): Promise<void> {
    await Promise.all([mkdir(this.requestDirectory, { recursive: true }), mkdir(this.receiptDirectory, { recursive: true })]);
  }

  public async writeRequest(value: MoltbookActionRequest): Promise<{ written: boolean; path: string }> {
    const request = MoltbookActionRequestSchema.parse(value);
    await this.initialize();
    const path = join(this.requestDirectory, `${request.requestId}.json`);
    try {
      const existing = MoltbookActionRequestSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
      if (existing.requestHash !== request.requestHash) throw new Error("Existing publisher request has a different hash");
      return { written: false, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await atomicCreate(path, request);
    return { written: true, path };
  }

  public async readReceipt(requestId: string): Promise<MoltbookPublicationReceipt | undefined> {
    try { return MoltbookPublicationReceiptSchema.parse(JSON.parse(await readFile(join(this.receiptDirectory, `${safeId(requestId)}.json`), "utf8")) as unknown); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  public async readRequest(requestId: string): Promise<MoltbookActionRequest | undefined> {
    try { return MoltbookActionRequestSchema.parse(JSON.parse(await readFile(join(this.requestDirectory, `${safeId(requestId)}.json`), "utf8")) as unknown); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

export class PublicationReceiptProcessor {
  public constructor(
    private readonly outbox: LocalOutbox,
    private readonly persistence: PersistenceLike = {},
    private readonly verification: ContractVerificationOptions = {},
  ) {}

  public async process(request: MoltbookActionRequest, receipt: MoltbookPublicationReceipt): Promise<ReturnType<typeof verifyMoltbookPublicationReceipt>> {
    const verified = verifyMoltbookPublicationReceipt(receipt, request, this.verification);
    if (verified.disposition === "ACKNOWLEDGE") {
      const acknowledged = await this.outbox.acknowledge(receipt.actionId, receipt.publishedAt);
      if (!acknowledged) {
        const state = await this.outbox.getState(receipt.actionId);
        if (state?.status !== "ACKNOWLEDGED") throw new Error(`Cannot acknowledge missing outbox action ${receipt.actionId}`);
      }
    } else {
      const failed = await this.outbox.fail(receipt.actionId, receipt.errorMessage ?? receipt.errorCode ?? receipt.status, {
        receiptId: receipt.receiptId,
        receiptStatus: receipt.status,
        requestId: receipt.requestId,
        reconciliationRequired: verified.disposition === "QUARANTINE",
        verificationRequired: receipt.status === "VERIFICATION_REQUIRED",
      }, receipt.observedAt);
      if (!failed) {
        const state = await this.outbox.getState(receipt.actionId);
        if (state?.status !== "FAILED" || state.failureDetails?.receiptId !== receipt.receiptId) throw new Error(`Cannot quarantine missing outbox action ${receipt.actionId}`);
      }
    }
    // Transition the filesystem state before durable publication persistence so a
    // stale-read reconciliation cannot leave SQLite published while outbox stays failed.
    await this.persistence.savePublication?.(verified.publication);
    return verified;
  }
}

async function atomicCreate(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try { await link(temporary, path); } finally { await unlink(temporary).catch(() => undefined); }
}

function safeId(value: string): string {
  const normalized = value.trim();
  if (!normalized || !/^[a-zA-Z0-9_-]+$/u.test(normalized)) throw new Error("Publisher request ID is invalid");
  return normalized;
}
