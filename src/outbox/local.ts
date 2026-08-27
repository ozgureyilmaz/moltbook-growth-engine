import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { NoActionDecision, ActionPayload } from "../orchestrator/contracts";
import { parseActionPayload, type OutboxPayload } from "./payload";
import type { ActionSecurityOptions } from "../schemas";
import { actionIdempotencyKey, commentHash } from "../domain/identifiers";
import { parseActionTransport, serializeActionTransport } from "./transport";

export type OutboxState = {
  status: "PENDING" | "ACKNOWLEDGED" | "FAILED";
  attemptCount: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
  runId: string;
  sourcePostId?: string;
  experimentId?: string;
  contentHash?: string;
  acknowledgedAt?: string;
  failedAt?: string;
  lastAttemptAt?: string;
  nextRetryAt?: string;
  errorMessage?: string;
  failureDetails?: Record<string, unknown>;
};

export type OutboxEntry = { payload: OutboxPayload; filePath: string; state?: OutboxState };

export type LocalOutboxOptions = ActionSecurityOptions & { maxAttempts?: number };

/** Local, idempotent handoff. No publishing or network call is performed here. */
export class LocalOutbox {
  private readonly pendingDir: string;
  private readonly acknowledgedDir: string;
  private readonly failedDir: string;
  private readonly options: LocalOutboxOptions;

  public constructor(root = "outbox", options: LocalOutboxOptions = { mode: "dry-run" }) {
    this.pendingDir = join(root, "pending");
    this.acknowledgedDir = join(root, "acknowledged");
    this.failedDir = join(root, "failed");
    this.options = { mode: "dry-run", maxAttempts: 3, ...options };
    if (!Number.isInteger(this.options.maxAttempts ?? 3) || (this.options.maxAttempts ?? 3) < 1) throw new Error("outbox maxAttempts must be a positive integer");
  }

  public async initialize(): Promise<void> {
    await Promise.all([mkdir(this.pendingDir, { recursive: true }), mkdir(this.acknowledgedDir, { recursive: true }), mkdir(this.failedDir, { recursive: true })]);
  }

  public async enqueue(payload: ActionPayload | NoActionDecision): Promise<{ written: boolean; filePath: string }> {
    const parsed = parseActionPayload(payload, this.options);
    await this.initialize();
    const filePath = join(this.pendingDir, `${payload.actionId}.json`);
    for (const directory of [this.pendingDir, this.acknowledgedDir, this.failedDir]) {
      const existingPath = join(directory, `${parsed.actionId}.json`);
      if (await this.readPayload(existingPath)) return { written: false, filePath: existingPath };
    }
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(serializeActionTransport(parsed), null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      await link(temporary, filePath);
    } catch (error) {
      await this.removeFile(temporary);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return { written: false, filePath };
      throw error;
    }
    await this.removeFile(temporary);
    await this.writeState(this.statePath(filePath), {
      status: "PENDING",
      attemptCount: 0,
      maxAttempts: this.options.maxAttempts ?? 3,
      createdAt: parsed.metadata.createdAt,
      updatedAt: parsed.metadata.createdAt,
      idempotencyKey: actionIdempotencyKey(parsed),
      runId: parsed.metadata.runId,
      ...(parsed.target?.postId ? { sourcePostId: parsed.target.postId } : {}),
      ...(parsed.action === "COMMENT" ? { experimentId: parsed.experiment.experimentId, contentHash: commentHash(parsed.content.comment) } : {}),
    });
    return { written: true, filePath };
  }

  public async listPending(): Promise<OutboxEntry[]> {
    await this.initialize();
    const names = (await readdir(this.pendingDir)).filter((name) => name.endsWith(".json") && !name.endsWith(".meta.json")).sort();
    const entries: OutboxEntry[] = [];
    for (const name of names) {
      const filePath = join(this.pendingDir, name);
      try {
        const payload = parseActionTransport(JSON.parse(await readFile(filePath, "utf8")) as unknown, this.options);
        entries.push({ payload, filePath, state: await this.ensureState(filePath, payload, "PENDING") });
      } catch {
        // Invalid files remain visible on disk for operator inspection.
      }
    }
    return entries;
  }

  public async acknowledge(actionId: string, acknowledgedAt = new Date().toISOString()): Promise<boolean> {
    await this.initialize();
    const source = join(this.pendingDir, `${actionId}.json`);
    const target = join(this.acknowledgedDir, `${actionId}.json`);
    const payload = await this.readPayload(source);
    if (!payload) return Boolean(await this.readPayload(target));
    await rename(source, target);
    const state = await this.ensureState(source, payload, "PENDING");
    await this.writeState(this.statePath(target), { ...state, status: "ACKNOWLEDGED", acknowledgedAt, updatedAt: acknowledgedAt });
    await this.removeFile(this.statePath(source));
    return true;
  }

  public async fail(actionId: string, errorMessage = "outbox handoff failed", failureDetails: Record<string, unknown> = {}, failedAt = new Date().toISOString()): Promise<boolean> {
    await this.initialize();
    const source = join(this.pendingDir, `${actionId}.json`);
    const target = join(this.failedDir, `${actionId}.json`);
    const payload = await this.readPayload(source);
    if (!payload) return Boolean(await this.readPayload(target));
    await rename(source, target);
    const prior = await this.ensureState(source, payload, "PENDING");
    const state: OutboxState = {
      ...prior,
      status: "FAILED",
      attemptCount: Math.min(prior.attemptCount + 1, prior.maxAttempts),
      failedAt,
      lastAttemptAt: failedAt,
      errorMessage,
      failureDetails,
      updatedAt: failedAt,
    };
    await this.writeState(this.statePath(target), state);
    await this.removeFile(this.statePath(source));
    return true;
  }

  public async retry(actionId: string, attemptedAt = new Date().toISOString()): Promise<boolean> {
    await this.initialize();
    const source = join(this.failedDir, `${actionId}.json`);
    const target = join(this.pendingDir, `${actionId}.json`);
    const payload = await this.readPayload(source);
    if (!payload) return false;
    const state = await this.readState(this.statePath(source));
    if (!state || state.attemptCount >= state.maxAttempts) return false;
    await rename(source, target);
    await this.writeState(this.statePath(target), { ...state, status: "PENDING", lastAttemptAt: attemptedAt, nextRetryAt: undefined, updatedAt: attemptedAt });
    await this.removeFile(this.statePath(source));
    return true;
  }

  public async getState(actionId: string): Promise<OutboxState | undefined> {
    await this.initialize();
    for (const directory of [this.pendingDir, this.acknowledgedDir, this.failedDir]) {
      const state = await this.readState(join(directory, `${actionId}.json.meta.json`));
      if (state) return state;
    }
    return undefined;
  }

  private statePath(payloadPath: string): string {
    return `${payloadPath}.meta.json`;
  }

  private async readPayload(filePath: string): Promise<OutboxPayload | undefined> {
    try {
      return parseActionTransport(JSON.parse(await readFile(filePath, "utf8")) as unknown, this.options);
    } catch {
      return undefined;
    }
  }

  private async readState(filePath: string): Promise<OutboxState | undefined> {
    try { return JSON.parse(await readFile(filePath, "utf8")) as OutboxState; } catch { return undefined; }
  }

  private async ensureState(payloadPath: string, payload: OutboxPayload, status: OutboxState["status"]): Promise<OutboxState> {
    const existing = await this.readState(this.statePath(payloadPath));
    if (existing) return existing;
    const state: OutboxState = {
      status,
      attemptCount: 0,
      maxAttempts: this.options.maxAttempts ?? 3,
      createdAt: payload.metadata.createdAt,
      updatedAt: payload.metadata.createdAt,
      idempotencyKey: actionIdempotencyKey(payload),
      runId: payload.metadata.runId,
      ...(payload.target?.postId ? { sourcePostId: payload.target.postId } : {}),
      ...(payload.action === "COMMENT" ? { experimentId: payload.experiment.experimentId, contentHash: commentHash(payload.content.comment) } : {}),
    };
    await this.writeState(this.statePath(payloadPath), state);
    return state;
  }

  private async writeState(filePath: string, state: OutboxState): Promise<void> {
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, filePath);
  }

  private async removeFile(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
